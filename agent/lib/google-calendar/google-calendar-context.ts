/**
 * Google Calendar authorization derived from Eve session auth.
 *
 * Export:
 * - `requireGoogleCalendarAuthorization`: verified family member and Telegram destination.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";

export interface GoogleCalendarAuthorization extends GoogleIntegrationAuthorization {
  telegramChatType: "group" | "private" | "supergroup";
}

export function requireGoogleCalendarAuthorization(
  ctx: Pick<SessionContext, "session">,
): GoogleCalendarAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const role = attributes?.role;
  const chatType = attributes?.telegramChatType;
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof attributes?.familyId !== "string" ||
    typeof attributes.telegramChatId !== "string" ||
    !["group", "private", "supergroup"].includes(String(chatType)) ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_GOOGLE_CONTEXT_INVALID",
      "Не удалось определить пользователя для Google Calendar",
    );
  }
  return {
    familyId: attributes.familyId,
    role: role as GoogleCalendarAuthorization["role"],
    telegramChatId: attributes.telegramChatId,
    telegramChatType: chatType as GoogleCalendarAuthorization["telegramChatType"],
    userId: caller.principalId,
  };
}
