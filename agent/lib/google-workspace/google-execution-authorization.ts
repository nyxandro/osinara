/**
 * Transactional Google Workspace execution authorization.
 *
 * Exports:
 * - `withGoogleWorkspaceExecutionAccount`: holds membership, workspace, account, and credential
 *   read locks through the caller's credentialed side effect, waiting for the profile.
 * - `tryWithGoogleWorkspaceExecutionAccount`: the same without waiting: a profile already in use
 *   (by the model) answers `busy`, so background work never queues ahead of a person.
 */
import { database } from "../database.js";
import { GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED } from "../../config.js";
import { assertGoogleWorkspaceAccess } from "./google-integration-access.js";
import type {
  DecryptedGoogleAccount,
  GoogleIntegrationAuthorization,
} from "./google-integration-contract.js";
import {
  type CredentialRow,
  googleAccountFromRow,
} from "./google-integration-persistence.js";
import { decryptGoogleToken } from "./google-token-crypto.js";

const GOOGLE_WORKSPACE_PROVIDER = "google_workspace";

function decryptedAccount(row: CredentialRow, encryptionKey: string): DecryptedGoogleAccount {
  return {
    ...googleAccountFromRow(row),
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
}

const BUSY = Symbol("google-workspace-profile-busy");

async function runWithProfileAccount<T>(
  auth: GoogleIntegrationAuthorization,
  encryptionKey: string,
  operation: (account: DecryptedGoogleAccount | null) => Promise<T>,
  wait: boolean,
): Promise<T | typeof BUSY> {
  const client = await database().connect();
  let profileLocked = false;
  try {
    // One connection owns both the profile advisory lock and row-level authorization locks. This
    // avoids nested pool acquisition while the credentialed command is running.
    if (wait) {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, $2))",
        [auth.workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
      );
    } else {
      const attempt = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked",
        [auth.workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
      );
      if (!attempt.rows[0]!.locked) return BUSY;
    }
    profileLocked = true;
    await client.query("BEGIN");
    await assertGoogleWorkspaceAccess(client, auth, false);
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
         AND account.is_default AND account.status = 'active'
       FOR SHARE OF account, credential`,
      [auth.workspaceId, GOOGLE_WORKSPACE_PROVIDER],
    );
    const row = result.rows[0];
    const value = await operation(row ? decryptedAccount(row, encryptionKey) : null);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    if (profileLocked) await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      if (profileLocked) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
          [auth.workspaceId, GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED],
        );
      }
    } finally {
      client.release();
    }
  }
}

export async function withGoogleWorkspaceExecutionAccount<T>(
  auth: GoogleIntegrationAuthorization,
  encryptionKey: string,
  operation: (account: DecryptedGoogleAccount | null) => Promise<T>,
): Promise<T> {
  return await runWithProfileAccount(auth, encryptionKey, operation, true) as T;
}

export async function tryWithGoogleWorkspaceExecutionAccount<T>(
  auth: GoogleIntegrationAuthorization,
  encryptionKey: string,
  operation: (account: DecryptedGoogleAccount | null) => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> {
  const result = await runWithProfileAccount(auth, encryptionKey, operation, false);
  return result === BUSY ? { busy: true } : { busy: false, value: result as T };
}
