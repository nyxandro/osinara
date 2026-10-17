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
 * - In a private chat only a delivery that stands for the answer itself (a voice note, a GIF) is
 *   projected, exactly like the channel projects a delivered answer; a sent file is followed by the
 *   text answer that the channel projects.
 * - Telegram already confirmed the side effect, so a projection failure is logged under the
 *   caller's code and reported as `false`, never thrown: an error would invite a duplicate send.
 */
import type { ToolContext } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "./sessions/session-context.js";
import type { RecordTelegramAgentResponseInput } from "./telegram-agent-timeline-repository.js";
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

export async function recordToolDeliveryInTimeline(
  ctx: ToolContext,
  target: ToolDeliveryTimelineTarget,
  input: {
    attachment?: RecordTelegramAgentResponseInput["attachment"];
    contentText: string;
    failureCode: string;
    /** Whether the delivery is the answer itself, so a private conversation must remember it too. */
    replacesAnswer: boolean;
    telegramMessageId: string;
  },
): Promise<boolean> {
  const privateAnswer = target.groupId === null && input.replacesAnswer && target.conversationId !== null;
  if (target.groupId === null && !privateAnswer) return true;
  try {
    const sessionId = applicationSessionId(ctx);
    const replyToEntryId = stringAttribute(ctx, "telegramTimelineEntryId");
    if (target.groupId !== null) {
      await telegramGroupJournalRepository.recordAgentResponse({
        applicationSessionId: sessionId,
        ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
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
