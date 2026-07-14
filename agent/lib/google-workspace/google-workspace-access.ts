/**
 * Fresh Google Workspace access-token service.
 *
 * Export:
 * - `requireGoogleWorkspaceAccess`: loads the user's grant and refreshes it before expiry.
 */
import {
  GOOGLE_WORKSPACE_ACCESS_TOKEN_REFRESH_SKEW_MILLISECONDS,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";
import { refreshGoogleAccessToken } from "./google-oauth-client.js";

export async function requireGoogleWorkspaceAccess(
  auth: GoogleIntegrationAuthorization,
  now = new Date(),
): Promise<{ accessToken: string; accountDisplayName: string }> {
  const config = requireGoogleOAuthEnvironment();
  const account = await googleIntegrationRepository.getDefaultAccount(auth, config.encryptionKey);
  const refreshCutoff = now.getTime() + GOOGLE_WORKSPACE_ACCESS_TOKEN_REFRESH_SKEW_MILLISECONDS;
  if (account.accessTokenExpiresAt.getTime() > refreshCutoff) {
    return { accessToken: account.accessToken, accountDisplayName: account.displayName };
  }

  // Refresh is performed once and persisted; provider failures bubble up without hidden retries.
  const refreshed = await refreshGoogleAccessToken(config, account.refreshToken);
  const accessTokenExpiresAt = new Date(now.getTime() + refreshed.expiresInSeconds * 1_000);
  await googleIntegrationRepository.updateAccessToken(auth, account.id, {
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt,
    encryptionKey: config.encryptionKey,
    scopes: refreshed.scopes,
  });
  return { accessToken: refreshed.accessToken, accountDisplayName: account.displayName };
}
