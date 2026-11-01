/**
 * Persistence of sandbox API keys, their grants and their usage.
 *
 * Exports:
 * - `ApiKeyTarget`: who a key is granted to; `ApiKeySettings`: where and how the key is sent.
 * - `apiKeyRepository`: the owner's operations, the webhook intake, the proxy projection, the
 *   sandbox environment and the usage the proxy reports.
 *
 * A key belongs to a family. A grant binds it to one workspace and carries that workspace's own
 * placeholder; the owner's personal workspace gets a grant as soon as the key is requested.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  createApiKeyPlaceholder,
  type ApiKeyAuthScheme,
  type ApiKeyEncryptedValue,
  type ApiKeyProjectionGrant,
  type ApiKeyUsageEvent,
} from "./api-key-contract.js";

export type ApiKeyTarget =
  | { readonly kind: "family" }
  | { readonly kind: "group"; readonly telegramChatId: string }
  | { readonly kind: "personal" };

export interface ApiKeySettings {
  readonly authHeader: string;
  readonly authScheme: ApiKeyAuthScheme;
  readonly purpose: string;
  readonly upstreamBaseUrl: string;
}

export interface ApiKeyGrantSummary {
  readonly grantedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly target:
    | { readonly kind: "family" }
    | { readonly kind: "group"; readonly telegramChatId: string; readonly title: string }
    | { readonly kind: "personal" };
  readonly uses: number;
  readonly usesLast7Days: number;
}

export interface ApiKeySummary extends ApiKeySettings {
  readonly awaitingValueUntil: Date | null;
  readonly grants: readonly ApiKeyGrantSummary[];
  readonly name: string;
  readonly valueStoredAt: Date | null;
}

export interface OpenApiKeyIntake {
  readonly keyId: string;
  readonly name: string;
}

interface KeyRow {
  auth_header: string;
  auth_scheme: ApiKeyAuthScheme;
  id: string;
  intake_expires_at: Date | null;
  name: string;
  purpose: string;
  upstream_base_url: string;
  value_stored_at: Date | null;
}

const KEY_COLUMNS = "id, name, purpose, upstream_base_url, auth_header, auth_scheme, value_stored_at, intake_expires_at";

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function keyNotFound(name: string): AppError {
  return new AppError(
    "AGENT_API_KEY_NOT_FOUND",
    "Такого ключа нет. Посмотрите список ключей и повторите с точным именем",
    { details: { name } },
  );
}

/**
 * The workspace a target names. A grant creates it on first use like any other workspace; a
 * revocation only looks it up and gets null when it was never created.
 */
async function targetWorkspace(
  client: PoolClient,
  input: { create: boolean; familyId: string; ownerUserId: string; target: ApiKeyTarget },
): Promise<string | null> {
  let groupId: string | null = null;
  if (input.target.kind === "group") {
    const group = await client.query<{ id: string }>(
      `SELECT id FROM telegram_groups
        WHERE family_id = $1 AND telegram_chat_id = $2 AND type = 'external'`,
      [input.familyId, input.target.telegramChatId],
    );
    if (!group.rows[0]) {
      throw new AppError(
        "AGENT_API_KEY_GROUP_NOT_FOUND",
        "Такой внешней группы нет в вашей семье. Для семейных групп выдайте ключ всей семье",
        { details: { telegramChatId: input.target.telegramChatId } },
      );
    }
    groupId = group.rows[0].id;
  }
  const values = [input.familyId, input.target.kind === "personal" ? input.ownerUserId : null, groupId, input.target.kind];
  const workspace = input.create
    ? await client.query<{ id: string }>(
      `INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (family_id, scope, owner_user_id, group_id) DO UPDATE SET family_id = EXCLUDED.family_id
       RETURNING id`,
      values,
    )
    : await client.query<{ id: string }>(
      `SELECT id FROM workspaces
        WHERE family_id = $1 AND owner_user_id IS NOT DISTINCT FROM $2 AND group_id IS NOT DISTINCT FROM $3
          AND scope = $4`,
      values,
    );
  return workspace.rows[0]?.id ?? null;
}

async function insertGrant(
  client: PoolClient,
  input: { grantedBy: string; keyId: string; workspaceId: string },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO sandbox_api_key_grants (key_id, workspace_id, placeholder, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key_id, workspace_id) WHERE revoked_at IS NULL DO NOTHING`,
    [input.keyId, input.workspaceId, createApiKeyPlaceholder(), input.grantedBy],
  );
  return inserted.rowCount === 1;
}

export const apiKeyRepository = {
  /**
   * Creates the key or reopens the wait for a new value of an existing one, and grants it to the
   * owner's personal workspace. A stored key keeps its destination: only a key without a value yet
   * may change it, and then its grants beyond the personal one are revoked, because the owner
   * approved them for the old address. Another key's open wait in the same chat refuses the
   * request: the owner's next message must belong to one key only.
   */
  async openIntake(input: ApiKeySettings & {
    expiresAt: Date;
    familyId: string;
    guardUntil: Date;
    name: string;
    ownerUserId: string;
    telegramChatId: string;
  }): Promise<{ created: boolean; keyId: string }> {
    return await transaction(async (client) => {
      const existing = await client.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM sandbox_api_keys WHERE family_id = $1 AND name = $2 FOR UPDATE`,
        [input.familyId, input.name],
      );
      const current = existing.rows[0];
      const destinationChanged = current !== undefined && (
        current.upstream_base_url !== input.upstreamBaseUrl ||
        current.auth_header !== input.authHeader ||
        current.auth_scheme !== input.authScheme
      );
      if (current?.value_stored_at && destinationChanged) {
        throw new AppError(
          "AGENT_API_KEY_DESTINATION_LOCKED",
          "У сохранённого ключа нельзя сменить адрес сервиса или заголовок. Удалите ключ и запросите его заново",
          { details: { name: input.name } },
        );
      }
      const busy = await client.query<{ name: string }>(
        `SELECT name FROM sandbox_api_keys
          WHERE intake_chat_id = $1 AND intake_expires_at > now() AND NOT (family_id = $2 AND name = $3)
          FOR UPDATE`,
        [input.telegramChatId, input.familyId, input.name],
      );
      if (busy.rows[0]) {
        throw new AppError(
          "AGENT_API_KEY_INTAKE_BUSY",
          `Я уже жду ключ «${busy.rows[0].name}». Пусть владелец сначала пришлёт его или напишет любое другое сообщение, чтобы отменить ожидание`,
          { details: { name: busy.rows[0].name } },
        );
      }
      // The chat's single wait slot moves to this key; this key's guard covers the chat from now on.
      await client.query(
        `UPDATE sandbox_api_keys SET intake_chat_id = NULL, intake_expires_at = NULL, intake_guard_until = NULL
          WHERE intake_chat_id = $1 AND NOT (family_id = $2 AND name = $3)`,
        [input.telegramChatId, input.familyId, input.name],
      );
      const saved = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO sandbox_api_keys
           (family_id, name, purpose, upstream_base_url, auth_header, auth_scheme, created_by,
            intake_chat_id, intake_expires_at, intake_guard_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (family_id, name) DO UPDATE
           SET purpose = EXCLUDED.purpose,
               upstream_base_url = EXCLUDED.upstream_base_url,
               auth_header = EXCLUDED.auth_header,
               auth_scheme = EXCLUDED.auth_scheme,
               intake_chat_id = EXCLUDED.intake_chat_id,
               intake_expires_at = EXCLUDED.intake_expires_at,
               intake_guard_until = EXCLUDED.intake_guard_until
         RETURNING id, (xmax = 0) AS inserted`,
        [input.familyId, input.name, input.purpose, input.upstreamBaseUrl, input.authHeader, input.authScheme,
          input.ownerUserId, input.telegramChatId, input.expiresAt, input.guardUntil],
      );
      const keyId = saved.rows[0]!.id;
      const personal = await targetWorkspace(client, {
        create: true, familyId: input.familyId, ownerUserId: input.ownerUserId, target: { kind: "personal" },
      });
      if (destinationChanged) {
        await client.query(
          `UPDATE sandbox_api_key_grants SET revoked_at = now(), revoked_by = $3
            WHERE key_id = $1 AND workspace_id <> $2 AND revoked_at IS NULL`,
          [keyId, personal, input.ownerUserId],
        );
      }
      await insertGrant(client, { grantedBy: input.ownerUserId, keyId, workspaceId: personal! });
      return { created: saved.rows[0]!.inserted, keyId };
    });
  },

  /**
   * What a private message of this chat may be: the awaited key (`open`), a key sent too late or
   * twice within the guard (`guarded`), or the very update that already delivered a key, sent
   * again by Telegram (`delivered`).
   */
  async findIntake(input: { telegramChatId: string; updateId: string }): Promise<
    | { readonly kind: "delivered" }
    | ({ readonly expiresAt: Date; readonly kind: "open" } & OpenApiKeyIntake)
    | ({ readonly kind: "guarded" } & OpenApiKeyIntake)
    | null
  > {
    const result = await database().query<{
      delivered: boolean;
      id: string;
      intake_expires_at: Date | null;
      name: string;
      open: boolean;
    }>(
      `SELECT id, name, intake_expires_at, value_update_id IS NOT DISTINCT FROM $2 AS delivered,
              intake_expires_at > now() AS open
         FROM sandbox_api_keys
        WHERE (intake_chat_id = $1 AND intake_guard_until > now()) OR value_update_id = $2
        ORDER BY delivered DESC
        LIMIT 1`,
      [input.telegramChatId, input.updateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.delivered) return { kind: "delivered" };
    return row.open
      ? { expiresAt: row.intake_expires_at!, keyId: row.id, kind: "open", name: row.name }
      : { keyId: row.id, kind: "guarded", name: row.name };
  },

  /**
   * Stores the value only while the very wait the message was matched to is still open, then
   * closes the wait and keeps the guard, so a second copy of the key is withheld too.
   */
  async storeValue(input: {
    expiresAt: Date;
    keyId: string;
    telegramChatId: string;
    updateId: string;
    value: ApiKeyEncryptedValue;
  }): Promise<boolean> {
    const result = await database().query(
      `UPDATE sandbox_api_keys
          SET value_ciphertext = $3, value_nonce = $4, value_auth_tag = $5, value_stored_at = now(),
              value_update_id = $6, intake_expires_at = now()
        WHERE id = $1 AND intake_chat_id = $2 AND intake_expires_at = $7 AND intake_expires_at > now()`,
      [input.keyId, input.telegramChatId, input.value.ciphertext, input.value.nonce, input.value.authTag,
        input.updateId, input.expiresAt],
    );
    return result.rowCount === 1;
  },

  /** Ends the wait; the guard stays, so a key sent after all is still withheld from the model. */
  async cancelIntake(input: { keyId: string; telegramChatId: string }): Promise<void> {
    await database().query(
      `UPDATE sandbox_api_keys SET intake_expires_at = now()
        WHERE id = $1 AND intake_chat_id = $2 AND intake_expires_at > now()`,
      [input.keyId, input.telegramChatId],
    );
  },

  async list(familyId: string): Promise<ApiKeySummary[]> {
    const keys = await database().query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM sandbox_api_keys WHERE family_id = $1 ORDER BY name`,
      [familyId],
    );
    const grants = await database().query<{
      created_at: Date;
      key_id: string;
      last_used_at: Date | null;
      scope: "family" | "group" | "personal";
      telegram_chat_id: string | null;
      title: string | null;
      uses: string;
      uses_last_7_days: string;
    }>(
      `SELECT g.key_id, g.created_at, w.scope, tg.telegram_chat_id, tg.title,
              usage.uses, usage.uses_last_7_days, usage.last_used_at
         FROM sandbox_api_key_grants g
         JOIN sandbox_api_keys k ON k.id = g.key_id
         JOIN workspaces w ON w.id = g.workspace_id
         LEFT JOIN telegram_groups tg ON tg.id = w.group_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS uses,
                  count(*) FILTER (WHERE u.used_at > now() - interval '7 days') AS uses_last_7_days,
                  max(u.used_at) AS last_used_at
             FROM sandbox_api_key_usage u
            WHERE u.grant_id = g.id
         ) usage
        WHERE k.family_id = $1 AND g.revoked_at IS NULL
        ORDER BY g.created_at`,
      [familyId],
    );
    return keys.rows.map((key) => ({
      authHeader: key.auth_header,
      authScheme: key.auth_scheme,
      awaitingValueUntil: key.intake_expires_at,
      grants: grants.rows.filter((grant) => grant.key_id === key.id).map((grant) => ({
        grantedAt: grant.created_at,
        lastUsedAt: grant.last_used_at,
        target: grant.scope === "group"
          ? { kind: "group" as const, telegramChatId: grant.telegram_chat_id!, title: grant.title! }
          : { kind: grant.scope },
        uses: Number(grant.uses),
        usesLast7Days: Number(grant.uses_last_7_days),
      })),
      name: key.name,
      purpose: key.purpose,
      upstreamBaseUrl: key.upstream_base_url,
      valueStoredAt: key.value_stored_at,
    }));
  },

  async find(input: { familyId: string; name: string }): Promise<(ApiKeySettings & { name: string }) | null> {
    const result = await database().query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM sandbox_api_keys WHERE family_id = $1 AND name = $2`,
      [input.familyId, input.name],
    );
    const key = result.rows[0];
    return key ? {
      authHeader: key.auth_header,
      authScheme: key.auth_scheme,
      name: key.name,
      purpose: key.purpose,
      upstreamBaseUrl: key.upstream_base_url,
    } : null;
  },

  async grant(input: {
    familyId: string;
    grantedBy: string;
    name: string;
    target: ApiKeyTarget;
  }): Promise<{ created: boolean }> {
    return await transaction(async (client) => {
      const key = await client.query<{ id: string }>(
        "SELECT id FROM sandbox_api_keys WHERE family_id = $1 AND name = $2",
        [input.familyId, input.name],
      );
      if (!key.rows[0]) throw keyNotFound(input.name);
      const workspaceId = await targetWorkspace(client, {
        create: true, familyId: input.familyId, ownerUserId: input.grantedBy, target: input.target,
      });
      return { created: await insertGrant(client, { grantedBy: input.grantedBy, keyId: key.rows[0].id, workspaceId: workspaceId! }) };
    });
  },

  async revoke(input: {
    familyId: string;
    name: string;
    revokedBy: string;
    target: ApiKeyTarget;
  }): Promise<boolean> {
    return await transaction(async (client) => {
      const key = await client.query<{ id: string }>(
        "SELECT id FROM sandbox_api_keys WHERE family_id = $1 AND name = $2",
        [input.familyId, input.name],
      );
      if (!key.rows[0]) throw keyNotFound(input.name);
      const workspaceId = await targetWorkspace(client, {
        create: false, familyId: input.familyId, ownerUserId: input.revokedBy, target: input.target,
      });
      if (workspaceId === null) return false;
      const revoked = await client.query(
        `UPDATE sandbox_api_key_grants SET revoked_at = now(), revoked_by = $3
          WHERE key_id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
        [key.rows[0].id, workspaceId, input.revokedBy],
      );
      return revoked.rowCount === 1;
    });
  },

  /** Deletes the key, its value, its grants and their usage. */
  async delete(input: { familyId: string; name: string }): Promise<boolean> {
    const result = await database().query(
      "DELETE FROM sandbox_api_keys WHERE family_id = $1 AND name = $2",
      [input.familyId, input.name],
    );
    return result.rowCount === 1;
  },

  /** Every active grant of a stored key on the server, as the proxy receives it. */
  async listProjectionGrants(): Promise<ApiKeyProjectionGrant[]> {
    const result = await database().query<{
      auth_header: string;
      auth_scheme: ApiKeyAuthScheme;
      grant_id: string;
      name: string;
      placeholder: string;
      scope: "family" | "group" | "personal";
      upstream_base_url: string;
      value_auth_tag: string;
      value_ciphertext: string;
      value_nonce: string;
      workspace_id: string;
    }>(
      `SELECT g.id AS grant_id, g.placeholder, g.workspace_id, w.scope, k.name, k.upstream_base_url,
              k.auth_header, k.auth_scheme, k.value_ciphertext, k.value_nonce, k.value_auth_tag
         FROM sandbox_api_key_grants g
         JOIN sandbox_api_keys k ON k.id = g.key_id
         JOIN workspaces w ON w.id = g.workspace_id
        WHERE g.revoked_at IS NULL AND k.value_stored_at IS NOT NULL
        ORDER BY g.id`,
    );
    return result.rows.map((row) => ({
      authHeader: row.auth_header,
      authScheme: row.auth_scheme,
      grantId: row.grant_id,
      keyName: row.name,
      // Personal and family sandboxes share the trusted network; each group has its own.
      network: row.scope === "group" ? { kind: "group", workspaceId: row.workspace_id } : { kind: "trusted" },
      placeholder: row.placeholder,
      upstreamBaseUrl: row.upstream_base_url,
      value: { authTag: row.value_auth_tag, ciphertext: row.value_ciphertext, nonce: row.value_nonce },
    }));
  },

  /** The stored keys granted to these workspaces, in the order of the workspaces given. */
  async environmentGrants(workspaceIds: readonly string[]): Promise<Array<{ name: string; placeholder: string }>> {
    if (workspaceIds.length === 0) return [];
    const result = await database().query<{ name: string; placeholder: string }>(
      `SELECT k.name, g.placeholder
         FROM sandbox_api_key_grants g
         JOIN sandbox_api_keys k ON k.id = g.key_id
        WHERE g.workspace_id = ANY($1::uuid[]) AND g.revoked_at IS NULL AND k.value_stored_at IS NOT NULL
        ORDER BY array_position($1::uuid[], g.workspace_id), k.name`,
      [workspaceIds],
    );
    return result.rows;
  },

  /** Records reported uses once each; a use of a grant deleted meanwhile is dropped. */
  async recordUsage(events: readonly ApiKeyUsageEvent[]): Promise<number> {
    const result = await database().query(
      `INSERT INTO sandbox_api_key_usage (id, grant_id, used_at, response_status)
       SELECT event.id, event.grant_id, event.used_at, event.status
         FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[], $4::integer[])
              AS event(id, grant_id, used_at, status)
         JOIN sandbox_api_key_grants g ON g.id = event.grant_id
       ON CONFLICT (id) DO NOTHING`,
      [
        events.map((event) => event.id),
        events.map((event) => event.grantId),
        events.map((event) => event.usedAt),
        events.map((event) => event.status),
      ],
    );
    return result.rowCount ?? 0;
  },
};
