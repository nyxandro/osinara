/**
 * Google Workspace OAuth initiation service.
 *
 * Export:
 * - `startGoogleWorkspaceAuthorization`: stores one-time state and privately delivers consent URL.
 */
import { randomBytes } from "node:crypto";

import {
  GOOGLE_OAUTH_STATE_TTL_MILLISECONDS,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";
import { buildGoogleAuthorizationUrl } from "./google-oauth-client.js";
import { deliverGoogleAuthorizationLink } from "./google-oauth-delivery.js";

export async function startGoogleWorkspaceAuthorization(
  auth: GoogleIntegrationAuthorization,
  now = new Date(),
): Promise<{ expiresAt: string; notice: string }> {
  const config = requireGoogleOAuthEnvironment();
  const rawState = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + GOOGLE_OAUTH_STATE_TTL_MILLISECONDS);
  await googleIntegrationRepository.createAuthorization(auth, { expiresAt, rawState });
  await deliverGoogleAuthorizationLink(
    auth.telegramChatId,
    buildGoogleAuthorizationUrl(config, rawState),
    expiresAt,
  );
  return {
    expiresAt: expiresAt.toISOString(),
    notice: "Ссылка для подключения Google Workspace отправлена в этот личный чат.",
  };
}
