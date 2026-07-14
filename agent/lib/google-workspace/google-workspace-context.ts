/**
 * Google Workspace authorization derived from the active Eve caller.
 *
 * Export:
 * - `requireGoogleWorkspaceAuthorization`: current verified family member in a private Telegram chat.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";

export function requireGoogleWorkspaceAuthorization(
  ctx: Pick<SessionContext, "session">,
): GoogleIntegrationAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const role = attributes?.role;
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof attributes?.familyId !== "string" ||
    typeof attributes.telegramChatId !== "string" ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID",
      "Не удалось определить пользователя Google Workspace. Отправьте запрос в личном чате",
    );
  }
  if (attributes.telegramChatType !== "private") {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_PRIVATE_ONLY",
      "Google Workspace доступен только в личном чате с агентом",
    );
  }
  return {
    familyId: attributes.familyId,
    role: role as GoogleIntegrationAuthorization["role"],
    telegramChatId: attributes.telegramChatId,
    userId: caller.principalId,
  };
}
