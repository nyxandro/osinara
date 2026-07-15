/**
 * Google Workspace profile actor derived from the active Eve caller.
 *
 * Exports:
 * - `requireGoogleWorkspaceConnectionActor`: verified personal or family profile actor.
 * - `resolveGoogleWorkspaceAuthorization`: resolves the exact current workspace ID.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceRepository } from "../workspaces/workspace-repository.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";

export function requireGoogleWorkspaceConnectionActor(
  ctx: Pick<SessionContext, "session">,
): Omit<GoogleIntegrationAuthorization, "workspaceId"> {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const role = attributes?.role;
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof attributes?.familyId !== "string" ||
    typeof attributes.telegramUserId !== "string" ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID",
      "Не удалось определить пользователя или область Google Workspace",
    );
  }
  const personal = attributes.telegramChatType === "private" &&
    (attributes.groupType === undefined || attributes.groupType === null);
  const family = ["group", "supergroup"].includes(String(attributes.telegramChatType)) &&
    attributes.groupType === "family_private" &&
    typeof attributes.groupId === "string";
  if (!personal && !family) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID",
      "Google Workspace доступен только в личном чате или семейной группе",
    );
  }
  return {
    familyId: attributes.familyId,
    role: role as GoogleIntegrationAuthorization["role"],
    scope: personal ? "personal" : "family",
    telegramUserId: attributes.telegramUserId,
    userId: caller.principalId,
  };
}

export async function resolveGoogleWorkspaceAuthorization(
  ctx: Pick<SessionContext, "session">,
): Promise<GoogleIntegrationAuthorization> {
  const actor = requireGoogleWorkspaceConnectionActor(ctx);
  const mounts = await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
  const profile = mounts.find((mount) => mount.mountPoint === actor.scope);
  if (!profile) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID",
      "Не удалось определить изолированный профиль Google Workspace",
    );
  }
  return { ...actor, workspaceId: profile.workspaceId };
}
