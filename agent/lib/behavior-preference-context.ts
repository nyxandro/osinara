/**
 * Verified current-chat authorization for communication preferences.
 *
 * Exports:
 * - `BehaviorPreferenceAuthorization`: exact conversation, actor, source, and sequence.
 * - `BehaviorPreferenceReadAuthorization`: interactive source or server-authored scheduled target.
 * - `requireBehaviorPreferenceAuthorization`: projects trusted Telegram auth or fails closed.
 * - `requireBehaviorPreferenceReadAuthorization`: also admits read-only scheduled and wake-up auth.
 */
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext } from "eve/instructions";

import { scheduledDeliveryMetadata } from "./agent-schedules/scheduled-session.js";
import { AppError } from "./app-error.js";
import { resolveSessionCaller } from "./session-auth.js";
import { conversationWakeupRunId } from "./conversation-wakeups/conversation-wakeup-turn.js";

export interface BehaviorPreferenceAuthorization {
  conversationId: string;
  sourceSequence: string;
  telegramUserId: string;
  timelineEntryId: string;
}

export interface BehaviorPreferenceBoundChatReadAuthorization {
  actorUserId: string;
  familyId: string;
  groupId: string | null;
  kind: "approval" | "scheduled" | "wakeup";
  scope: "family" | "group" | "personal";
  telegramChatId: string;
}

export type BehaviorPreferenceReadAuthorization =
  | BehaviorPreferenceAuthorization
  | BehaviorPreferenceBoundChatReadAuthorization;

type PreferenceContext =
  | Pick<DynamicResolveContext, "session">
  | Pick<SessionContext, "session">;

function contextError(): AppError {
  return new AppError(
    "AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID",
    "Не удалось определить текущий Telegram-чат для настройки общения. Отправьте просьбу ещё раз",
  );
}

export function requireBehaviorPreferenceAuthorization(
  ctx: PreferenceContext,
): BehaviorPreferenceAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const sourceSequence = attributes?.telegramTimelineSequence;
  const telegramUserId = attributes?.telegramUserId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;

  // All mutation ordering and scope come from the current verified Telegram source, never the model.
  // A bot tunes how the agent talks to it exactly like a person; it just holds no account, so its
  // principal stays a service identity while the Telegram user id below does the identifying.
  if (
    (caller?.principalType !== "user" && caller?.principalType !== "service") ||
    caller.authenticator !== "telegram" ||
    typeof conversationId !== "string" ||
    typeof sourceSequence !== "string" ||
    !/^\d+$/u.test(sourceSequence) ||
    typeof telegramUserId !== "string" ||
    telegramUserId.length === 0 ||
    typeof timelineEntryId !== "string"
  ) {
    throw contextError();
  }

  return {
    conversationId,
    sourceSequence,
    telegramUserId,
    timelineEntryId,
  };
}

export function requireBehaviorPreferenceReadAuthorization(
  ctx: PreferenceContext,
): BehaviorPreferenceReadAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attrs = caller?.attributes;
  if (attrs?.telegramApprovalContinuation === "true") {
    const scope = attrs.telegramApprovalScope;
    if (caller?.authenticator !== "telegram" || caller.principalType !== "user" ||
        typeof attrs.familyId !== "string" || typeof attrs.telegramChatId !== "string" ||
        (scope !== "personal" && scope !== "family") ||
        (scope === "personal" ? attrs.telegramChatType !== "private" : attrs.groupType !== "family_private" || typeof attrs.groupId !== "string")) {
      throw contextError();
    }
    return { actorUserId: caller.principalId, familyId: attrs.familyId,
      groupId: scope === "personal" ? null : attrs.groupId as string,
      kind: "approval", scope, telegramChatId: attrs.telegramChatId };
  }
  // A wake-up turn continues its chat's conversation, but answers no message: read the chat's prompt.
  if (conversationWakeupRunId(ctx.session.auth) !== null) {
    const family = attrs?.groupType === "family_private" && typeof attrs.groupId === "string";
    if (
      caller?.authenticator !== "telegram" || caller.principalType !== "user" ||
      typeof attrs?.familyId !== "string" || typeof attrs.telegramChatId !== "string" ||
      (!family && attrs.telegramChatType !== "private")
    ) {
      throw contextError();
    }
    return {
      actorUserId: caller.principalId,
      familyId: attrs.familyId,
      groupId: family ? attrs.groupId as string : null,
      kind: "wakeup",
      scope: family ? "family" : "personal",
      telegramChatId: attrs.telegramChatId,
    };
  }
  // Scheduled runs carry a server-authored delivery target but intentionally have no user message.
  const scheduled = scheduledDeliveryMetadata(ctx);
  if (scheduled) {
    const caller = resolveSessionCaller(ctx);
    const callerScheduledRunId = caller?.attributes?.scheduledRunId;

    // Never combine a normal current caller with delivery metadata inherited from another principal.
    if (
      !caller ||
      caller.principalType !== "user" ||
      caller.authenticator !== "telegram" ||
      callerScheduledRunId !== scheduled.runId
    ) {
      throw contextError();
    }
    return {
      actorUserId: caller.principalId,
      familyId: scheduled.familyId,
      groupId: scheduled.groupId,
      kind: "scheduled",
      scope: scheduled.scope,
      telegramChatId: scheduled.telegramChatId,
    };
  }
  return requireBehaviorPreferenceAuthorization(ctx);
}
