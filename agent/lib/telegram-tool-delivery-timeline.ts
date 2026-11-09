/**
 * History of a Telegram message that a tool delivered itself.
 *
 * Exports:
 * - `ToolDeliveryTimelineTarget`: the verified group, topic and conversation of a delivery.
 * - `toolDeliveryTimelineTarget`: resolves that target before anything is sent, so a malformed
 *   topic stops the send instead of a confirmed message losing its history.
 * - `recordToolDeliveryInTimeline`: records a confirmed delivery and binds its reply route.
 *
 * Key constructs:
 * - Tool deliveries bypass Telegram channel events, so a confirmed group delivery is projected into
 *   the group timeline here and bound to a reply route before a participant can answer it.
 * - A tool delivers only what stands for the answer itself (a voice note, a GIF), so in a private
 *   chat it is projected exactly like the channel projects a delivered answer. Files go inside the
 *   answer the channel delivers.
 * - Telegram already confirmed the side effect, so a projection failure is logged under the
 *   caller's code and reported as `false`, never thrown: an error would invite a duplicate send.
 * - A scenario run's own session closes with the run (#480): what a tool sent in it is recorded the
 *   way the run's final text is, as one of the scenario's messages that the chat's conversation reads
 *   later, and no reply is routed to the run. A group's journal names no session for it, as for the
 *   final text (`channels/telegram.ts`).
 */
import type { ToolContext } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import { scheduledDeliveryMetadata, type ScheduledDeliveryMetadata } from "./agent-schedules/scheduled-session.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { database } from "./database.js";
import { recordProactiveDelivery } from "./proactive-deliveries/proactive-delivery-repository.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "./sessions/session-context.js";
import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "./workspaces/workspace-context.js";

export interface ToolDeliveryTimelineTarget {
  chatId: string;
  conversationId: string | null;
  forumTopicId?: string;
  groupId: string | null;
  messageThreadId?: number;
}

function stringAttribute(ctx: ToolContext, name: string): string | null {
  const value = ctx.session.auth.current?.attributes[name];
  return typeof value === "string" ? value : null;
}

function currentForumTopicId(ctx: ToolContext): string | undefined {
  const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
  if (forumTopicId !== undefined &&
    (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))) {
    throw new AppError(
      "AGENT_TELEGRAM_FORUM_TOPIC_INVALID",
      "Не удалось определить тему для истории отправленного сообщения",
    );
  }
  return forumTopicId;
}

export function toolDeliveryTimelineTarget(ctx: ToolContext): ToolDeliveryTimelineTarget {
  const { groupId } = requireWorkspaceAuthorization(ctx);
  const { chatId, messageThreadId } = requireTelegramDeliveryTarget(ctx);
  const forumTopicId = currentForumTopicId(ctx);
  return {
    chatId,
    conversationId: stringAttribute(ctx, "telegramConversationId"),
    groupId,
    ...(forumTopicId === undefined ? {} : { forumTopicId }),
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  };
}

/** One message a tool sent in a scenario run, recorded as the scenario's own (#480). */
async function recordScheduledToolDelivery(
  scheduled: ScheduledDeliveryMetadata,
  target: ToolDeliveryTimelineTarget,
  input: { contentText: string; telegramMessageId: string },
): Promise<void> {
  const deliveredAt = new Date();
  await recordProactiveDelivery(database(), {
    content: input.contentText,
    deliveredAt,
    familyId: scheduled.familyId,
    groupId: scheduled.groupId,
    messageThreadId: scheduled.messageThreadId,
    ownerUserId: scheduled.ownerUserId,
    scheduledFor: new Date(scheduled.scheduledFor),
    scope: scheduled.scope,
    sourceId: scheduled.runId,
    sourceKind: "agent_schedule",
    telegramChatId: scheduled.telegramChatId,
    telegramMessageId: input.telegramMessageId,
    title: scheduled.title,
  });
  if (target.groupId === null) return;
  await telegramGroupJournalRepository.recordAgentResponse({
    applicationSessionId: null,
    contentText: input.contentText,
    deliveredAt,
    groupId: target.groupId,
    messageThreadId: scheduled.forumTopicId ?? target.forumTopicId ?? null,
    replyToEntryId: null,
    telegramMessageIds: [input.telegramMessageId],
  });
}

export async function recordToolDeliveryInTimeline(
  ctx: ToolContext,
  target: ToolDeliveryTimelineTarget,
  input: {
    contentText: string;
    failureCode: string;
    telegramMessageId: string;
  },
): Promise<boolean> {
  let scheduled: ScheduledDeliveryMetadata | null;
  try {
    scheduled = scheduledDeliveryMetadata(ctx);
    if (scheduled !== null) {
      await recordScheduledToolDelivery(scheduled, target, input);
      return true;
    }
  } catch (error) {
    console.error(JSON.stringify({
      code: input.failureCode,
      error: error instanceof Error ? error.message : String(error),
      telegramMessageId: input.telegramMessageId,
    }));
    return false;
  }
  if (target.groupId === null && target.conversationId === null) return true;
  try {
    const sessionId = applicationSessionId(ctx);
    const replyToEntryId = stringAttribute(ctx, "telegramTimelineEntryId");
    if (target.groupId !== null) {
      await telegramGroupJournalRepository.recordAgentResponse({
        applicationSessionId: sessionId,
        contentText: input.contentText,
        deliveredAt: new Date(),
        groupId: target.groupId,
        messageThreadId: target.forumTopicId ?? null,
        replyToEntryId,
        telegramMessageIds: [input.telegramMessageId],
      });
    } else {
      await conversationTimelineRepository.recordAgentResponse({
        applicationSessionId: sessionId,
        contentText: input.contentText,
        conversationId: target.conversationId!,
        deliveredAt: new Date(),
        messageThreadId: null,
        replyToEntryId,
        telegramMessageIds: [input.telegramMessageId],
      });
    }
    await registerTelegramMessageRoutes({
      applicationSessionId: sessionId,
      chatId: target.chatId,
      messageIds: [input.telegramMessageId],
      ...(target.messageThreadId === undefined ? {} : { messageThreadId: target.messageThreadId }),
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      code: input.failureCode,
      error: error instanceof Error ? error.message : String(error),
      telegramMessageId: input.telegramMessageId,
    }));
    return false;
  }
}
