/**
 * Verified current-chat authorization for communication preferences.
 *
 * Exports:
 * - `BehaviorPreferenceAuthorization`: exact conversation, actor, source, and sequence.
 * - `BehaviorPreferenceReadAuthorization`: interactive source, server-authored scheduled target, or a
 *   channel post's source.
 * - `requireBehaviorPreferenceAuthorization`: projects trusted Telegram auth or fails closed.
 * - `requireBehaviorPreferenceReadAuthorization`: also admits read-only scheduled, wake-up and channel auth.
 */
import type { SessionContext } from "../runtime/context.js";
import type { DynamicResolveContext } from "../runtime/context.js";

import { scheduledDeliveryMetadata } from "./agent-schedules/scheduled-session.js";
import { AppError } from "./app-error.js";
import { resolveSessionCaller } from "./session-auth.js";
import { resolveTelegramSessionActor } from "./telegram-session-actor.js";
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

/** A post on behalf of a channel: no Telegram user, so it reads its external group's notes only. */
export interface BehaviorPreferenceChannelReadAuthorization {
  conversationId: string;
  kind: "channel";
  sourceSequence: string;
  telegramSenderChatId: string;
  timelineEntryId: string;
}

export type BehaviorPreferenceReadAuthorization =
  | BehaviorPreferenceAuthorization
  | BehaviorPreferenceBoundChatReadAuthorization
  | BehaviorPreferenceChannelReadAuthorization;

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
  // Said plainly: the generic refusal asks to send the request again, which a channel never can.
  if (attributes?.telegramActorKind === "telegram_channel") {
    throw new AppError(
      "AGENT_BEHAVIOR_PREFERENCE_CHANNEL_FORBIDDEN",
      "Сообщение от имени канала не может менять заметки чата: это может сделать участник от своего имени",
    );
  }
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
  // The notes belong to the chat, not to the author, and the group's memory is already read here.
  if (attrs?.telegramActorKind === "telegram_channel") {
    const actor = resolveTelegramSessionActor(ctx.session.auth);
    const sequence = attrs.telegramTimelineSequence;
    if (
      actor?.kind !== "telegram_channel" || attrs.groupType !== "external" ||
      typeof attrs.telegramConversationId !== "string" || typeof attrs.telegramTimelineEntryId !== "string" ||
      typeof sequence !== "string" || !/^\d+$/u.test(sequence)
    ) {
      throw contextError();
    }
    return {
      conversationId: attrs.telegramConversationId,
      kind: "channel",
      sourceSequence: sequence,
      telegramSenderChatId: actor.id,
      timelineEntryId: attrs.telegramTimelineEntryId,
    };
  }
  return requireBehaviorPreferenceAuthorization(ctx);
}
