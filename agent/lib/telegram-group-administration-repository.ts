/**
 * PostgreSQL Telegram group administration repository.
 *
 * Exports:
 * - `TelegramGroupRegistration`: complete persisted registration input.
 * - `TelegramGroupPolicyUpdate`: complete external-group policy replacement input.
 * - `TelegramGroupSkillUpdate`: complete safe-skill policy replacement input.
 * - `TelegramGroupStatus`: complete read-only registration and policy projection.
 * - `TelegramGroupSessionRotation`: owner-requested canonical rotation for every group topic.
 * - `TelegramGroupAdministrationRepository`: injectable registration/removal/policy contract.
 * - `telegramGroupAdministrationRepository`: family-scoped group lifecycle operations.
 */
import {
  SESSION_GROUP_ROTATION_LOCK_HASH_SEED,
  TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED,
} from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { stopGroupSandboxes, updateGroupPermissions } from "./telegram-group-policy-repository.js";
import { workingFamilySkills } from "./family-skills/family-skill-repository.js";
import { skillGrantCatalog, skillNeedsBash } from "./family-skills/skill-grants.js";
import type {
  RegisteredGroupType,
  StandardTelegramGroupMessageMode,
  TelegramGroupMessageMode,
} from "./family-access.js";

interface TelegramGroupRegistrationBase {
  familyId: string;
  requestedBy: string;
  telegramChatId: string;
  title: string;
  toolAllowlist: string[];
}

export type TelegramGroupRegistration = TelegramGroupRegistrationBase & (
  | {
    messageMode: StandardTelegramGroupMessageMode;
    type: "family_private";
  }
  | {
    messageMode: TelegramGroupMessageMode;
    type: Exclude<RegisteredGroupType, "family_private">;
  }
);

export interface TelegramGroupPolicyUpdate {
  familyId: string;
  messageMode: TelegramGroupMessageMode;
  requestedBy: string;
  telegramChatId: string;
  toolAllowlist: string[];
}

export interface TelegramGroupSkillUpdate {
  familyId: string;
  requestedBy: string;
  skillAllowlist: string[];
  telegramChatId: string;
}

export interface TelegramGroupStatus {
  messageMode: TelegramGroupMessageMode;
  skillAllowlist: string[];
  telegramChatId: string;
  title: string;
  toolAllowlist: string[];
  type: RegisteredGroupType;
}

export interface TelegramGroupSessionRotation {
  familyId: string;
  requestedBy: string;
  telegramChatId: string;
}

export interface TelegramGroupAdministrationRepository {
  listStatuses(input: {
    familyId: string;
    requestedBy: string;
  }): Promise<TelegramGroupStatus[]>;
  registerGroup(input: TelegramGroupRegistration): Promise<{ groupId: string }>;
  removeRegistration(input: {
    familyId: string;
    requestedBy: string;
    telegramChatId: string;
  }): Promise<{ groupId: string }>;
  requestGroupSessionRotation(input: TelegramGroupSessionRotation): Promise<{
    groupId: string;
    requestedCanonicalSessions: number;
  }>;
  updatePolicy(input: TelegramGroupPolicyUpdate): Promise<{ groupId: string }>;
  updateSkills(input: TelegramGroupSkillUpdate): Promise<{ groupId: string; skillsNeedBash: boolean }>;
}

export const telegramGroupAdministrationRepository: TelegramGroupAdministrationRepository = {
  async listStatuses(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Keep the current owner membership locked until the family-scoped policy read completes.
      const owner = await client.query(
        `SELECT 1
           FROM family_memberships
          WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
          FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Return the exact persisted configuration; effective external base tools are added by the
      // model-facing tool from the same static catalog used by execution policy.
      const result = await client.query<{
        message_mode: TelegramGroupMessageMode;
        telegram_chat_id: string;
        title: string;
        skill_allowlist: string[];
        tool_allowlist: string[];
        type: RegisteredGroupType;
      }>(
        `SELECT telegram_chat_id, title, type, message_mode, tool_allowlist, skill_allowlist
           FROM telegram_groups
          WHERE family_id = $1
          ORDER BY lower(title), telegram_chat_id`,
        [input.familyId],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        messageMode: row.message_mode,
        skillAllowlist: row.skill_allowlist,
        telegramChatId: row.telegram_chat_id,
        title: row.title,
        toolAllowlist: row.tool_allowlist,
        type: row.type,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async registerGroup(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Lock current ownership so a parked HITL action cannot outlive role revocation.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Receipt-time media policy and trust-zone replacement share this chat-level lock.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // A type change crosses a trust boundary, so replace the row and cascade all scoped data.
      const existing = await client.query<{ family_id: string; id: string; type: RegisteredGroupType; skill_allowlist: string[]; tool_allowlist: string[] }>(
        `SELECT id, family_id, type, skill_allowlist, tool_allowlist
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR UPDATE`,
        [input.telegramChatId],
      );
      const current = existing.rows[0];
      if (current && current.family_id !== input.familyId) {
        throw new AppError(
          "AGENT_GROUP_REGISTRATION_CONFLICT",
          "Группа уже принадлежит другой семье",
        );
      }
      if (current && (current.type !== input.type || JSON.stringify(current.tool_allowlist) !== JSON.stringify(input.toolAllowlist))) {
        await stopGroupSandboxes(client, current.id);
      }
      if (current && current.type !== input.type) {
        await client.query("DELETE FROM telegram_groups WHERE id = $1", [current.id]);
      }
      const catalog = skillGrantCatalog(await workingFamilySkills(client, input.familyId));

      // A conflicting chat owned by another family is never reassigned through an upsert.
      const result = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, tool_allowlist, message_mode, skill_allowlist)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (telegram_chat_id)
         DO UPDATE SET title = EXCLUDED.title,
                       type = EXCLUDED.type,
                        tool_allowlist = EXCLUDED.tool_allowlist,
                        skill_allowlist = EXCLUDED.skill_allowlist,
                       message_mode = EXCLUDED.message_mode
         WHERE telegram_groups.family_id = EXCLUDED.family_id
         RETURNING id`,
        [
          input.familyId,
          input.telegramChatId,
          input.title,
          input.type,
          input.toolAllowlist,
          input.messageMode,
          current?.type === input.type
            ? current.skill_allowlist.filter((name) => input.toolAllowlist.includes("bash") || !skillNeedsBash(catalog, name))
            : [],
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_REGISTRATION_CONFLICT",
          "Группа уже принадлежит другой семье",
        );
      }

      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async requestGroupSessionRotation(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Authorization is current at mutation time, not inherited from the private session snapshot.
      const owner = await client.query(
        `SELECT 1
           FROM family_memberships
          WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
          FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Serialize exact-chat administration so registration replacement or removal cannot race
      // selection of the trust zone whose canonical sessions are being rotated.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );
      const registered = await client.query<{ id: string }>(
        `SELECT id
           FROM telegram_groups
          WHERE family_id = $1 AND telegram_chat_id = $2
          FOR SHARE`,
        [input.familyId, input.telegramChatId],
      );
      const group = registered.rows[0];
      if (!group) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа с таким telegramChatId не зарегистрирована в вашей семье. " +
            "Вызовите manage_telegram_group ровно с {\"action\":\"status\"}, " +
            "выберите нужную группу и повторите готовый startNewContextInput из результата",
        );
      }

      // Session preparation takes the same group-wide lock before its route lock. Once acquired,
      // the following statement sees every canonical generation committed before this request.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [group.id, SESSION_GROUP_ROTATION_LOCK_HASH_SEED],
      );

      // Canonical rows represent main chat and forum topics. Parked task sessions retain the exact
      // Eve state and requester binding needed to finish or deny their pending operation safely.
      const rotated = await client.query<{ id: string }>(
        `UPDATE conversation_sessions
            SET rotation_requested_at = now()
          WHERE family_id = $1
            AND group_id = $2
            AND kind = 'canonical'
            AND retired_at IS NULL
          RETURNING id`,
        [input.familyId, group.id],
      );
      await client.query("COMMIT");
      return {
        groupId: group.id,
        requestedCanonicalSessions: rotated.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async removeRegistration(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Keep authorization and deletion in one transaction to close the HITL revocation race.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Prevent removal from overtaking an in-flight media trust-zone decision.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // Both group keys remain mandatory so another family's registration is never deleted.
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM telegram_groups WHERE family_id=$1 AND telegram_chat_id=$2 FOR UPDATE",
        [input.familyId, input.telegramChatId],
      );
      if (existing.rows[0]) await stopGroupSandboxes(client, existing.rows[0].id);
      const result = await client.query<{ id: string }>(
        `DELETE FROM telegram_groups
         WHERE family_id = $1 AND telegram_chat_id = $2
         RETURNING id`,
        [input.familyId, input.telegramChatId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата",
        );
      }
      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  updatePolicy: updateGroupPermissions,
  updateSkills: updateGroupPermissions,
};
