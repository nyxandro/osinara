/**
 * PostgreSQL Google Workspace profile and encrypted OAuth credential boundary.
 *
 * Exports:
 * - Workspace-bound authorization, claim, account, and credential contracts.
 * - `googleIntegrationRepository`: one-time OAuth state, profile persistence, lookup, and removal.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { FamilyRole } from "../family-access.js";
import type {
  ClaimedGoogleAuthorization,
  DecryptedGoogleAccount,
  GoogleIntegrationAccount,
  GoogleIntegrationAuthorization,
  GoogleIntegrationScope,
} from "./google-integration-contract.js";
import { decryptGoogleToken, encryptGoogleToken } from "./google-token-crypto.js";

const CURRENT_ENCRYPTION_KEY_VERSION = 1;
const GOOGLE_WORKSPACE_PROVIDER = "google_workspace";

interface CompleteAuthorizationInput {
  accessToken: string;
  accessTokenExpiresAt: Date;
  displayName: string;
  encryptionKey: string;
  externalAccountId: string;
  refreshToken: string;
  scopes: string[];
}

interface AccountRow {
  display_name: string;
  external_account_id: string;
  id: string;
  is_default: boolean;
  status: "active" | "reauth_required" | "revoked";
}

interface CredentialRow extends AccountRow {
  access_token_auth_tag: string;
  access_token_ciphertext: string;
  access_token_expires_at: Date;
  access_token_nonce: string;
  refresh_token_auth_tag: string;
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  scopes: string[];
}

function stateHash(rawState: string): string {
  if (rawState.length < 16) {
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_STATE_INVALID",
      "Ссылка авторизации Google недействительна. Запросите новую ссылку в Telegram",
    );
  }
  return createHash("sha256").update(rawState).digest("hex");
}

function accountFromRow(row: AccountRow): GoogleIntegrationAccount {
  return {
    displayName: row.display_name,
    externalAccountId: row.external_account_id,
    id: row.id,
    isDefault: row.is_default,
    status: row.status,
  };
}

async function assertWorkspaceAccess(
  client: PoolClient,
  auth: GoogleIntegrationAuthorization,
  management: boolean,
): Promise<void> {
  const result = await client.query<{
    owner_user_id: string | null;
    role: FamilyRole;
    scope: "family" | "personal";
  }>(
    `SELECT workspace.owner_user_id, workspace.scope, membership.role
     FROM workspaces AS workspace
     JOIN family_memberships AS membership
       ON membership.family_id = workspace.family_id AND membership.user_id = $2
     WHERE workspace.id = $1 AND workspace.family_id = $3
       AND workspace.scope IN ('personal', 'family')
     FOR SHARE OF workspace, membership`,
    [auth.workspaceId, auth.userId, auth.familyId],
  );
  const workspace = result.rows[0];
  const personal = workspace?.scope === "personal" && workspace.owner_user_id === auth.userId;
  const family = workspace?.scope === "family";
  if (!workspace || workspace.scope !== auth.scope || (!personal && !family)) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED",
      "У вас нет доступа к этому профилю Google Workspace",
    );
  }
  if (management && family && workspace.role !== "owner") {
    throw new AppError(
      "AGENT_OWNER_REQUIRED",
      "Подключать и отключать общий Google Workspace может только владелец семьи",
    );
  }
}

export const googleIntegrationRepository = {
  async withProfileLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const client = await database().connect();
    let locked = false;
    try {
      // A session advisory lock serializes DB metadata and derived credential-file changes.
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, $2))",
        [workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
      );
      locked = true;
      return await operation();
    } finally {
      try {
        if (locked) {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
            [workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
          );
        }
      } finally {
        client.release();
      }
    }
  },

  async createAuthorization(
    auth: GoogleIntegrationAuthorization,
    input: { expiresAt: Date; rawState: string },
  ): Promise<{ expiresAt: string }> {
    if (Number.isNaN(input.expiresAt.getTime())) {
      throw new AppError("AGENT_GOOGLE_OAUTH_EXPIRY_INVALID", "Не удалось создать OAuth-ссылку");
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertWorkspaceAccess(client, auth, true);
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'failed', error_code = 'AGENT_GOOGLE_OAUTH_STATE_EXPIRED'
         WHERE workspace_id = $1 AND provider = $2
           AND status = 'pending' AND expires_at < now()`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      await client.query(
        `INSERT INTO oauth_authorizations
           (family_id, actor_user_id, workspace_id, provider, state_hash, telegram_chat_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          auth.familyId,
          auth.userId,
          auth.workspaceId,
          GOOGLE_WORKSPACE_PROVIDER,
          stateHash(input.rawState),
          auth.telegramUserId,
          input.expiresAt,
        ],
      );
      await client.query("COMMIT");
      return { expiresAt: input.expiresAt.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimAuthorization(rawState: string, now: Date): Promise<ClaimedGoogleAuthorization> {
    const result = await database().query<{
      actor_user_id: string;
      authorization_id: string;
      family_id: string;
      scope: GoogleIntegrationScope;
      telegram_chat_id: string;
      workspace_id: string;
    }>(
      `UPDATE oauth_authorizations AS oauth_row
       SET status = 'processing', claimed_at = $2
       FROM workspaces AS workspace
       WHERE oauth_row.state_hash = $1 AND oauth_row.provider = $3
         AND oauth_row.status = 'pending' AND oauth_row.expires_at >= $2
         AND workspace.id = oauth_row.workspace_id
         AND workspace.family_id = oauth_row.family_id
         AND (
           (workspace.scope = 'personal' AND workspace.owner_user_id = oauth_row.actor_user_id
             AND EXISTS (
               SELECT 1 FROM family_memberships
               WHERE family_id = oauth_row.family_id
                 AND user_id = oauth_row.actor_user_id
             ))
           OR
           (workspace.scope = 'family' AND EXISTS (
             SELECT 1 FROM family_memberships
             WHERE family_id = oauth_row.family_id
               AND user_id = oauth_row.actor_user_id AND role = 'owner'
           ))
         )
       RETURNING oauth_row.id AS authorization_id, oauth_row.family_id,
                 oauth_row.actor_user_id, oauth_row.workspace_id,
                 oauth_row.telegram_chat_id, workspace.scope`,
      [stateHash(rawState), now, GOOGLE_WORKSPACE_PROVIDER],
    );
    const claimed = result.rows[0];
    if (!claimed) {
      throw new AppError(
        "AGENT_GOOGLE_OAUTH_STATE_INVALID",
        "Ссылка авторизации Google недействительна или истекла. Запросите новую ссылку в Telegram",
      );
    }
    return {
      actorUserId: claimed.actor_user_id,
      authorizationId: claimed.authorization_id,
      familyId: claimed.family_id,
      scope: claimed.scope,
      telegramUserId: claimed.telegram_chat_id,
      workspaceId: claimed.workspace_id,
    };
  },

  async completeAuthorization(
    claim: ClaimedGoogleAuthorization,
    input: CompleteAuthorizationInput,
  ): Promise<GoogleIntegrationAccount> {
    if (!input.scopes.length) {
      throw new AppError("AGENT_GOOGLE_SCOPE_MISSING", "Google не предоставил разрешения Workspace");
    }
    const refresh = encryptGoogleToken(input.refreshToken, input.encryptionKey);
    const access = encryptGoogleToken(input.accessToken, input.encryptionKey);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const authorization = await client.query(
        `SELECT 1 FROM oauth_authorizations
         WHERE id = $1 AND family_id = $2 AND actor_user_id = $3 AND workspace_id = $4
           AND provider = $5 AND status = 'processing'
         FOR UPDATE`,
        [
          claim.authorizationId,
          claim.familyId,
          claim.actorUserId,
          claim.workspaceId,
          GOOGLE_WORKSPACE_PROVIDER,
        ],
      );
      if (!authorization.rowCount) {
        throw new AppError(
          "AGENT_GOOGLE_OAUTH_STATE_INVALID",
          "Авторизация Google уже завершена или отменена",
        );
      }

      // The workspace lock serializes replacements and default-account selection.
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [claim.workspaceId]);
      await client.query(
        `DELETE FROM integration_accounts
         WHERE workspace_id = $1 AND provider = $2 AND external_account_id <> $3`,
        [claim.workspaceId, GOOGLE_WORKSPACE_PROVIDER, input.externalAccountId],
      );
      const account = await client.query<AccountRow>(
        `INSERT INTO integration_accounts
           (family_id, connected_by_user_id, workspace_id, provider,
            external_account_id, display_name, status, scopes, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, true)
         ON CONFLICT (workspace_id, provider, external_account_id) DO UPDATE
         SET family_id = EXCLUDED.family_id,
             connected_by_user_id = EXCLUDED.connected_by_user_id,
             display_name = EXCLUDED.display_name, status = 'active',
             scopes = EXCLUDED.scopes, is_default = true,
             revoked_at = NULL, updated_at = now()
         RETURNING id, external_account_id, display_name, status, is_default`,
        [
          claim.familyId,
          claim.actorUserId,
          claim.workspaceId,
          GOOGLE_WORKSPACE_PROVIDER,
          input.externalAccountId,
          input.displayName,
          input.scopes,
        ],
      );
      const stored = account.rows[0]!;
      await client.query(
        `INSERT INTO integration_credentials
           (account_id, encryption_key_version,
            refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
            access_token_ciphertext, access_token_nonce, access_token_auth_tag,
            access_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (account_id) DO UPDATE
         SET encryption_key_version = EXCLUDED.encryption_key_version,
             refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
             refresh_token_nonce = EXCLUDED.refresh_token_nonce,
             refresh_token_auth_tag = EXCLUDED.refresh_token_auth_tag,
             access_token_ciphertext = EXCLUDED.access_token_ciphertext,
             access_token_nonce = EXCLUDED.access_token_nonce,
             access_token_auth_tag = EXCLUDED.access_token_auth_tag,
             access_token_expires_at = EXCLUDED.access_token_expires_at,
             updated_at = now()`,
        [
          stored.id,
          CURRENT_ENCRYPTION_KEY_VERSION,
          refresh.ciphertext,
          refresh.nonce,
          refresh.authTag,
          access.ciphertext,
          access.nonce,
          access.authTag,
          input.accessTokenExpiresAt,
        ],
      );
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'completed', completed_at = now(), error_code = NULL
         WHERE id = $1`,
        [claim.authorizationId],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'integration.connected', $3,
                 jsonb_build_object('provider', $4::text, 'scope', $5::text,
                                    'workspaceId', $6::text))`,
        [
          claim.familyId,
          claim.actorUserId,
          stored.id,
          GOOGLE_WORKSPACE_PROVIDER,
          claim.scope,
          claim.workspaceId,
        ],
      );
      await client.query("COMMIT");
      return accountFromRow(stored);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async failAuthorization(claim: ClaimedGoogleAuthorization, errorCode: string): Promise<void> {
    await database().query(
      `UPDATE oauth_authorizations
       SET status = 'failed', completed_at = now(), error_code = $2
       WHERE id = $1 AND provider = $3 AND status = 'processing'`,
      [claim.authorizationId, errorCode, GOOGLE_WORKSPACE_PROVIDER],
    );
  },

  async getDefaultAccount(
    auth: GoogleIntegrationAuthorization,
    encryptionKey: string,
  ): Promise<DecryptedGoogleAccount | null> {
    const client = await database().connect();
    try {
      await assertWorkspaceAccess(client, auth, false);
      const result = await client.query<CredentialRow>(
        `SELECT account.id, account.external_account_id, account.display_name, account.status,
                account.is_default, account.scopes,
                credential.refresh_token_ciphertext, credential.refresh_token_nonce,
                credential.refresh_token_auth_tag, credential.access_token_ciphertext,
                credential.access_token_nonce, credential.access_token_auth_tag,
                credential.access_token_expires_at
         FROM integration_accounts AS account
         JOIN integration_credentials AS credential ON credential.account_id = account.id
         WHERE account.workspace_id = $1 AND account.provider = $2
           AND account.is_default AND account.status = 'active'`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...accountFromRow(row),
        accessToken: decryptGoogleToken({
          authTag: row.access_token_auth_tag,
          ciphertext: row.access_token_ciphertext,
          nonce: row.access_token_nonce,
        }, encryptionKey),
        accessTokenExpiresAt: row.access_token_expires_at,
        refreshToken: decryptGoogleToken({
          authTag: row.refresh_token_auth_tag,
          ciphertext: row.refresh_token_ciphertext,
          nonce: row.refresh_token_nonce,
        }, encryptionKey),
        scopes: row.scopes,
      };
    } finally {
      client.release();
    }
  },

  async assertManagement(auth: GoogleIntegrationAuthorization): Promise<void> {
    const client = await database().connect();
    try {
      await assertWorkspaceAccess(client, auth, true);
    } finally {
      client.release();
    }
  },

  async disconnect(auth: GoogleIntegrationAuthorization): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertWorkspaceAccess(client, auth, true);
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM integration_accounts
         WHERE workspace_id = $1 AND provider = $2
         RETURNING id`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      for (const account of deleted.rows) {
        await client.query(
          `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'integration.disconnected', $3,
                   jsonb_build_object('provider', $4::text, 'scope', $5::text,
                                      'workspaceId', $6::text))`,
          [
            auth.familyId,
            auth.userId,
            account.id,
            GOOGLE_WORKSPACE_PROVIDER,
            auth.scope,
            auth.workspaceId,
          ],
        );
      }
      await client.query("COMMIT");
      return deleted.rowCount !== 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
