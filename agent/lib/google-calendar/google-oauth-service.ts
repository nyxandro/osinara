/**
 * Google OAuth initiation service.
 *
 * Export:
 * - `startGoogleCalendarAuthorization`: creates a one-time state and privately delivers consent URL.
 */
import { randomBytes } from "node:crypto";

import { AppError } from "../app-error.js";
import {
  GOOGLE_OAUTH_STATE_TTL_MILLISECONDS,
  requireGoogleOAuthEnvironment,
} from "./google-calendar-config.js";
import type { GoogleCalendarAuthorization } from "./google-calendar-context.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";
import { buildGoogleAuthorizationUrl } from "./google-oauth-client.js";
import { deliverGoogleAuthorizationLink } from "./google-oauth-delivery.js";

export async function startGoogleCalendarAuthorization(
  auth: GoogleCalendarAuthorization,
  now = new Date(),
): Promise<{ expiresAt: string; notice: string }> {
  if (auth.telegramChatType !== "private") {
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_PRIVATE_ONLY",
      "Подключить Google Calendar можно только в личном чате",
    );
  }
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
    notice: "Ссылка для подключения Google Calendar отправлена в этот личный чат.",
  };
}
