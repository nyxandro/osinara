/**
 * PostgreSQL Google integration account and credential boundary.
 *
 * Exports:
 * - Authorization, account, and decrypted credential contracts.
 * - `googleIntegrationRepository`: one-time OAuth state and encrypted grant persistence.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decryptGoogleToken, encryptGoogleToken } from "./google-token-crypto.js";

const CURRENT_ENCRYPTION_KEY_VERSION = 1;

export interface GoogleIntegrationAuthorization {
  familyId: string;
  role: "member" | "owner" | "recovery_owner";
  telegramChatId: string;
  userId: string;
}

export interface ClaimedGoogleAuthorization {
  authorizationId: string;
  familyId: string;
  telegramChatId: string;
  userId: string;
}

export interface GoogleIntegrationAccount {
  displayName: string;
  externalAccountId: string;
  id: string;
  isDefault: boolean;
  status: "active" | "reauth_required" | "revoked";
}

export interface DecryptedGoogleAccount extends GoogleIntegrationAccount {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  scopes: string[];
}

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

async function requireMembership(
  client: PoolClient,
  auth: GoogleIntegrationAuthorization,
): Promise<void> {
  const membership = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  if (!membership.rowCount) {
    throw new AppError("AGENT_ACCESS_DENIED", "У вас больше нет доступа к этой семье");
  }
}

export const googleIntegrationRepository = {
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
      await requireMembership(client, auth);
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'failed', error_code = 'AGENT_GOOGLE_OAUTH_STATE_EXPIRED'
         WHERE user_id = $1 AND provider = 'google_calendar'
           AND status = 'pending' AND expires_at < now()`,
        [auth.userId],
      );
      await client.query(
        `INSERT INTO oauth_authorizations
           (family_id, user_id, provider, state_hash, telegram_chat_id, expires_at)
         VALUES ($1, $2, 'google_calendar', $3, $4, $5)`,
        [auth.familyId, auth.userId, stateHash(input.rawState), auth.telegramChatId, input.expiresAt],
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
      authorization_id: string;
      family_id: string;
      telegram_chat_id: string;
      user_id: string;
    }>(
      `UPDATE oauth_authorizations AS auth_row
       SET status = 'processing', claimed_at = $2
       WHERE auth_row.state_hash = $1 AND auth_row.status = 'pending'
         AND auth_row.expires_at >= $2
         AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = auth_row.family_id AND user_id = auth_row.user_id
         )
       RETURNING auth_row.id AS authorization_id, auth_row.family_id,
                 auth_row.user_id, auth_row.telegram_chat_id`,
      [stateHash(rawState), now],
    );
    const claimed = result.rows[0];
    if (!claimed) {
      throw new AppError(
        "AGENT_GOOGLE_OAUTH_STATE_INVALID",
        "Ссылка авторизации Google недействительна или истекла. Запросите новую ссылку в Telegram",
      );
    }
    return {
      authorizationId: claimed.authorization_id,
      familyId: claimed.family_id,
      telegramChatId: claimed.telegram_chat_id,
      userId: claimed.user_id,
    };
  },

  async completeAuthorization(
    claim: ClaimedGoogleAuthorization,
    input: CompleteAuthorizationInput,
  ): Promise<GoogleIntegrationAccount> {
    if (!input.scopes.length) {
      throw new AppError("AGENT_GOOGLE_SCOPE_MISSING", "Google не предоставил Calendar permissions");
    }
    const refresh = encryptGoogleToken(input.refreshToken, input.encryptionKey);
    const access = encryptGoogleToken(input.accessToken, input.encryptionKey);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const authorization = await client.query(
        `SELECT 1 FROM oauth_authorizations
         WHERE id = $1 AND family_id = $2 AND user_id = $3 AND status = 'processing'
         FOR UPDATE`,
        [claim.authorizationId, claim.familyId, claim.userId],
      );
      if (!authorization.rowCount) {
        throw new AppError(
          "AGENT_GOOGLE_OAUTH_STATE_INVALID",
          "Авторизация Google уже завершена или отменена",
        );
      }
      // Serializing per user prevents concurrent first-account callbacks from both becoming default.
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [claim.userId]);
      const account = await client.query<AccountRow>(
        `INSERT INTO integration_accounts
           (family_id, user_id, provider, external_account_id, display_name, status, scopes, is_default)
         VALUES ($1, $2, 'google_calendar', $3, $4, 'active', $5,
                 NOT EXISTS (
                   SELECT 1 FROM integration_accounts
                   WHERE user_id = $2 AND provider = 'google_calendar'
                     AND is_default AND status <> 'revoked'
                 ))
         ON CONFLICT (user_id, provider, external_account_id) DO UPDATE
         SET family_id = EXCLUDED.family_id, display_name = EXCLUDED.display_name,
             status = 'active', scopes = EXCLUDED.scopes, revoked_at = NULL, updated_at = now()
         RETURNING id, external_account_id, display_name, status, is_default`,
        [
          claim.familyId,
          claim.userId,
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
                 jsonb_build_object('provider', 'google_calendar'))`,
        [claim.familyId, claim.userId, stored.id],
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
       WHERE id = $1 AND status = 'processing'`,
      [claim.authorizationId, errorCode],
    );
  },

  async getDefaultAccount(
    auth: GoogleIntegrationAuthorization,
    encryptionKey: string,
  ): Promise<DecryptedGoogleAccount> {
    const result = await database().query<CredentialRow>(
      `SELECT account.id, account.external_account_id, account.display_name, account.status,
              account.is_default, account.scopes,
              credential.refresh_token_ciphertext, credential.refresh_token_nonce,
              credential.refresh_token_auth_tag, credential.access_token_ciphertext,
              credential.access_token_nonce, credential.access_token_auth_tag,
              credential.access_token_expires_at
       FROM integration_accounts AS account
       JOIN integration_credentials AS credential ON credential.account_id = account.id
       JOIN family_memberships AS membership
         ON membership.family_id = account.family_id AND membership.user_id = account.user_id
       WHERE account.family_id = $1 AND account.user_id = $2
         AND account.provider = 'google_calendar' AND account.is_default
         AND account.status = 'active'`,
      [auth.familyId, auth.userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_INTEGRATION_AUTH_REQUIRED",
        "Подключите Google Calendar в личном чате",
      );
    }
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
  },
};
