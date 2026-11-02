/**
 * PostgreSQL Google Workspace profile and encrypted OAuth credential boundary.
 *
 * Exports:
 * - Workspace-bound authorization, claim, account, and credential contracts.
 * - `googleIntegrationRepository`: one-time OAuth state, profile persistence, lookup, and removal.
 */
import { GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED } from "../../config.js";
import { AppError } from "../app-error.js";
import { calendarMirrorRepository } from "../calendar-mirror/calendar-mirror-repository.js";
import { database } from "../database.js";
import { assertGoogleWorkspaceAccess } from "./google-integration-access.js";
import type {
  ClaimedGoogleAuthorization,
  GoogleIntegrationAccount,
  GoogleIntegrationAuthorization,
  GoogleIntegrationScope,
} from "./google-integration-contract.js";
import {
  type AccountRow,
  type CompleteAuthorizationInput,
  googleAccountFromRow,
  googleOAuthStateHash,
} from "./google-integration-persistence.js";
import { encryptGoogleToken } from "./google-token-crypto.js";

const CURRENT_ENCRYPTION_KEY_VERSION = 1;
const GOOGLE_WORKSPACE_PROVIDER = "google_workspace";

export const googleIntegrationRepository = {
  async createAuthorization(
    auth: GoogleIntegrationAuthorization,
    input: { expiresAt: Date; rawState: string },
  ): Promise<
    | { authorizationId: string; created: true; expiresAt: string }
    | { created: false; deliveryCompleted: boolean; expiresAt: string }
  > {
    if (Number.isNaN(input.expiresAt.getTime())) {
      throw new AppError("AGENT_GOOGLE_OAUTH_EXPIRY_INVALID", "Не удалось создать OAuth-ссылку");
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // A transaction lock makes the pending-state check atomic across concurrent connect calls.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [auth.workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
      );
      await assertGoogleWorkspaceAccess(client, auth, true);
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'failed', error_code = 'AGENT_GOOGLE_OAUTH_STATE_EXPIRED'
         WHERE workspace_id = $1 AND provider = $2
           AND status = 'pending' AND expires_at < now()`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      // Collapse states created by older or interrupted callers before reusing the newest link.
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'failed', completed_at = now(),
             error_code = 'AGENT_GOOGLE_OAUTH_STATE_SUPERSEDED'
         WHERE workspace_id = $1 AND provider = $2 AND status = 'pending'
           AND expires_at >= now()
           AND id <> COALESCE((
             SELECT id FROM oauth_authorizations
             WHERE workspace_id = $1 AND provider = $2 AND status = 'pending'
               AND expires_at >= now()
             ORDER BY created_at DESC
             LIMIT 1
           ), id)`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      const pending = await client.query<{
        delivery_completed_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT expires_at, delivery_completed_at FROM oauth_authorizations
         WHERE workspace_id = $1 AND provider = $2
           AND status = 'pending' AND expires_at >= now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
      if (pending.rows[0]) {
        await client.query("COMMIT");
        return {
          created: false,
          deliveryCompleted: pending.rows[0].delivery_completed_at !== null,
          expiresAt: pending.rows[0].expires_at.toISOString(),
        };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO oauth_authorizations
           (family_id, actor_user_id, workspace_id, provider, state_hash, telegram_chat_id,
            expires_at, delivery_started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         RETURNING id`,
        [
          auth.familyId,
          auth.userId,
          auth.workspaceId,
          GOOGLE_WORKSPACE_PROVIDER,
          googleOAuthStateHash(input.rawState),
          auth.telegramUserId,
          input.expiresAt,
        ],
      );
      const authorizationId = inserted.rows[0]?.id;
      if (!authorizationId) {
        throw new AppError(
          "AGENT_GOOGLE_OAUTH_STATE_CREATE_FAILED",
          "Не удалось создать OAuth-ссылку. Повторите подключение",
        );
      }
      await client.query("COMMIT");
      return { authorizationId, created: true, expiresAt: input.expiresAt.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async completeAuthorizationDelivery(
    auth: GoogleIntegrationAuthorization,
    authorizationId: string,
  ): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertGoogleWorkspaceAccess(client, auth, true);
      const completed = await client.query(
        `UPDATE oauth_authorizations
         SET delivery_completed_at = COALESCE(delivery_completed_at, now())
         WHERE id = $1 AND family_id = $2 AND actor_user_id = $3
           AND workspace_id = $4 AND provider = $5 AND status = 'pending'
           AND delivery_started_at IS NOT NULL`,
        [
          authorizationId,
          auth.familyId,
          auth.userId,
          auth.workspaceId,
          GOOGLE_WORKSPACE_PROVIDER,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new AppError(
          "AGENT_GOOGLE_OAUTH_DELIVERY_STATE_INVALID",
          "Не удалось подтвердить отправку OAuth-ссылки. Проверьте личный чат",
        );
      }
      await client.query("COMMIT");
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
       [googleOAuthStateHash(rawState), now, GOOGLE_WORKSPACE_PROVIDER],
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
    materializeProfile: () => Promise<void>,
  ): Promise<GoogleIntegrationAccount> {
    if (!input.scopes.length) {
      throw new AppError("AGENT_GOOGLE_SCOPE_MISSING", "Google не предоставил разрешения Workspace");
    }
    const refresh = encryptGoogleToken(input.refreshToken, input.encryptionKey);
    const access = encryptGoogleToken(input.accessToken, input.encryptionKey);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertGoogleWorkspaceAccess(client, {
        familyId: claim.familyId,
        scope: claim.scope,
        userId: claim.actorUserId,
        workspaceId: claim.workspaceId,
      }, true);
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
      // The reminders' Google Calendar follows the connection: no setting, it starts with it.
      await calendarMirrorRepository.applyConnection(client, {
        externalAccountId: input.externalAccountId,
        integrationAccountId: stored.id,
        workspaceId: claim.workspaceId,
      });
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
      // The derived gws profile is materialized before commit while the workspace row is locked.
      // Disconnect cannot delete DB credentials and then race a stale profile write.
      await materializeProfile();
      await client.query("COMMIT");
      return googleAccountFromRow(stored);
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

  async disconnect(
    auth: GoogleIntegrationAuthorization,
    removeProfile: () => Promise<void>,
  ): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertGoogleWorkspaceAccess(client, auth, true);
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [auth.workspaceId]);
      // Explicit disconnect also revokes every not-yet-completed consent link for this profile.
      await client.query(
        `UPDATE oauth_authorizations
         SET status = 'failed', completed_at = now(), error_code = 'AGENT_GOOGLE_OAUTH_DISCONNECTED'
         WHERE workspace_id = $1 AND provider = $2 AND status IN ('pending', 'processing')`,
        [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
      );
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
      await removeProfile();
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
