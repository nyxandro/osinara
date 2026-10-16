/**
 * The turn a wake-up delivers into its chat's own conversation.
 *
 * Exports:
 * - `CONVERSATION_WAKEUP_RUN_ATTRIBUTE`: trusted auth attribute that marks a wake-up turn.
 * - `conversationWakeupRunId`: the run of the current wake-up turn, or null for any other turn.
 * - `conversationCanonicalRouteToken`: the canonical route a message of that chat follows.
 * - `conversationWakeupAuth`: trusted auth of the wake-up turn.
 * - `conversationWakeupMessage`: the model-facing wake-up message.
 *
 * Key constructs:
 * - The auth mirrors an ordinary turn of the same chat, so the mode rules, the tool surface, and the
 *   instruction prefix stay byte-identical and the provider keeps reusing the conversation.
 * - It carries no Telegram message coordinates: the answer is a standalone message, a reaction has
 *   nothing to attach to, and memory has no current source.
 * - The run attribute is distinct from an isolated scheduled run's, so every isolated-run branch
 *   keeps treating this turn as an ordinary conversation turn.
 */
import type { SessionAuthContext } from "../../runtime/context.js";
import { telegramContinuationToken } from "../../runtime/telegram/api.js";

import { formatCurrentTimeContext } from "../current-time.js";
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { groupCanonicalContinuationToken } from "../sessions/group-canonical-token.js";
import { localScheduledTime } from "../scheduling/local-time.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";

export const CONVERSATION_WAKEUP_RUN_ATTRIBUTE = "conversationScheduleRunId";

export function conversationWakeupRunId(
  auth: { current?: { attributes: Readonly<Record<string, unknown>> } | null } | undefined,
): string | null {
  const runId = auth?.current?.attributes[CONVERSATION_WAKEUP_RUN_ATTRIBUTE];
  return typeof runId === "string" && runId ? runId : null;
}

function positiveInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function conversationCanonicalRouteToken(route: {
  groupId: string | null;
  messageThreadId: string | null;
  telegramChatId: string;
  telegramForumTopicId: string | null;
}): string {
  if (route.groupId !== null) {
    return groupCanonicalContinuationToken(route.groupId, positiveInteger(route.telegramForumTopicId) ?? null);
  }
  const messageThreadId = positiveInteger(route.messageThreadId);
  return telegramContinuationToken({
    chatId: route.telegramChatId,
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  });
}

/**
 * The dispatch coordinates are the ones a Telegram message's turn carries: the dispatch id, and a
 * deadline after which the turn fails at its start instead of running late.
 */
export function conversationWakeupAuth(
  wakeup: PreparedConversationWakeup,
  now: Date,
  dispatch: { deadlineAt: string; id: string },
): SessionAuthContext {
  const family = wakeup.scope === "family";
  return {
    attributes: {
      applicationSessionId: wakeup.applicationSessionId,
      [CONVERSATION_WAKEUP_RUN_ATTRIBUTE]: wakeup.runId,
      conversationScheduleId: wakeup.scheduleId,
      familyId: wakeup.familyId,
      ...(family && wakeup.groupId !== null ? { groupId: wakeup.groupId, groupType: "family_private" } : {}),
      memoryScopes: family ? ["family"] : ["personal", "family"],
      osinaraTelegramDeadlineAt: dispatch.deadlineAt,
      osinaraTelegramIngressId: dispatch.id,
      role: wakeup.role,
      sandboxSessionId: wakeup.sandboxSessionId,
      ...(family ? { skillAllowlist: wakeup.skillAllowlist } : {}),
      telegramActorId: wakeup.telegramUserId,
      telegramActorKind: "telegram_user",
      telegramChatId: wakeup.telegramChatId,
      telegramChatType: wakeup.telegramChatType,
      telegramConversationId: wakeup.applicationConversationId,
      ...(wakeup.forumTopicId === null ? {} : { telegramForumTopicId: wakeup.forumTopicId }),
      ...(wakeup.messageThreadId === null ? {} : { telegramMessageThreadId: wakeup.messageThreadId }),
      telegramTurnStartedAt: now.toISOString(),
      telegramUserId: wakeup.telegramUserId,
    },
    authenticator: "telegram",
    principalId: wakeup.authorUserId,
    principalType: "user",
  };
}

export function conversationWakeupMessage(wakeup: PreparedConversationWakeup, now: Date): { context: string[]; message: string } {
  return {
    context: [formatCurrentTimeContext(now)],
    message: [
      "<conversation_wakeup>",
      "This is your own scheduled wake-up in this conversation, not a message from a person. The rules are in the \"A wake-up in the conversation\" section.",
      `schedule_id: ${wakeup.scheduleId}`,
      `title: ${wakeup.title}`,
      `scheduled_for_local: ${localScheduledTime(wakeup.scheduledFor.toISOString(), wakeup.timezone)}`,
      `execution_number: ${wakeup.completedRuns + 1}`,
      `max_runs: ${wakeup.maxRuns}`,
      "original_user_request:",
      wakeup.userRequest,
      "note:",
      wakeup.scenarioPrompt,
      "</conversation_wakeup>",
      "Carry out the note taking the whole conversation into account.",
      "- If the goal is reached or there is nothing more to check, report the result and pause the scenario through manage_agent_schedule with action pause and this schedule_id.",
      `- If there is nothing to report but checks are still needed, end the turn with exactly the line ${EMPTY_DELIVERY_MARKER} and no other text: any phrase like "пока без изменений" would be sent to the chat.`,
      "- If execution_number equals max_runs, this is the last run: be sure to report the outcome, what never happened and whether it is worth continuing.",
      "- Do not put reactions and do not save facts through remember: a wake-up has no message from a person.",
    ].join("\n"),
  };
}
