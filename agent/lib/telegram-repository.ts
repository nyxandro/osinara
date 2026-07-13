/**
 * PostgreSQL repository for Telegram identities, groups, and owner bootstrap.
 *
 * Exports:
 * - `telegramRepository`: lookup and first-owner claim operations.
 * - `TelegramRepository`: injectable contract used by the channel boundary.
 */
import type { PoolClient } from "pg";

import { database } from "./database.js";
import type { FamilyIdentity, RegisteredGroup } from "./family-access.js";
import { verifyBootstrapCode } from "./bootstrap-code.js";

const INITIAL_FAMILY_NAME = "Семья";

export interface TelegramProfile {
  displayName: string;
  telegramUserId: string;
  username?: string;
}

export interface TelegramRepository {
  claimFirstOwner(code: string, profile: TelegramProfile): Promise<"claimed" | "configured" | "invalid">;
  findGroup(telegramChatId: string): Promise<RegisteredGroup | null>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  hasOwner(): Promise<boolean>;
}

async function ownerExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM family_memberships WHERE role = 'owner') AS exists",
  );
  return result.rows[0]?.exists === true;
}

export const telegramRepository: TelegramRepository = {
  async claimFirstOwner(code, profile) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      if (await ownerExists(client)) {
        await client.query("ROLLBACK");
        return "configured";
      }

      // Lock the only active code so concurrent Telegram deliveries cannot both claim ownership.
      const result = await client.query<{
        attempts: number;
        code_hash: string;
        created_at: Date;
        expires_at: Date;
        id: string;
      }>(
        `SELECT id, code_hash, attempts, created_at, expires_at
         FROM bootstrap_codes
         WHERE consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
      );
      const record = result.rows[0];
      if (!record) {
        await client.query("ROLLBACK");
        return "invalid";
      }

      const valid = verifyBootstrapCode({
        attempts: record.attempts,
        code,
        now: new Date(),
        record: {
          codeHash: record.code_hash,
          createdAt: record.created_at,
          expiresAt: record.expires_at,
        },
      });
      if (!valid) {
        await client.query("UPDATE bootstrap_codes SET attempts = attempts + 1 WHERE id = $1", [
          record.id,
        ]);
        await client.query("COMMIT");
        return "invalid";
      }

      // Owner, user, and family become visible atomically with code consumption.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ($1) RETURNING id",
        [INITIAL_FAMILY_NAME],
      );
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name, telegram_username)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [profile.telegramUserId, profile.displayName, profile.username ?? null],
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]?.id, user.rows[0]?.id],
      );
      await client.query("UPDATE bootstrap_codes SET consumed_at = now() WHERE id = $1", [record.id]);
      await client.query("COMMIT");
      return "claimed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async findGroup(telegramChatId) {
    const result = await database().query<{
      family_id: string;
      id: string;
      message_mode: RegisteredGroup["messageMode"];
      telegram_chat_id: string;
      tool_allowlist: string[];
      type: RegisteredGroup["type"];
    }>(
      `SELECT id, family_id, telegram_chat_id, type, message_mode, tool_allowlist
       FROM telegram_groups
       WHERE telegram_chat_id = $1`,
      [telegramChatId],
    );
    const row = result.rows[0];
    return row
      ? {
          familyId: row.family_id,
          groupId: row.id,
          messageMode: row.message_mode,
          telegramChatId: row.telegram_chat_id,
          toolAllowlist: row.tool_allowlist,
          type: row.type,
        }
      : null;
  },

  async findIdentity(telegramUserId) {
    const result = await database().query<{
      family_id: string;
      role: FamilyIdentity["role"];
      user_id: string;
    }>(
      `SELECT fm.family_id, fm.user_id, fm.role
       FROM users u
       JOIN family_memberships fm ON fm.user_id = u.id
       WHERE u.telegram_user_id = $1`,
      [telegramUserId],
    );
    const row = result.rows[0];
    return row ? { familyId: row.family_id, role: row.role, userId: row.user_id } : null;
  },

  async hasOwner() {
    const result = await database().query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM family_memberships WHERE role = 'owner') AS exists",
    );
    return result.rows[0]?.exists === true;
  },
};
