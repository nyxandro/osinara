/**
 * Exactly-once delivery of one workspace file into the current verified Telegram chat.
 *
 * Exports:
 * - `WorkspaceFileChatDeliveryInput`: file, rendering, and timeline projection of one delivery.
 * - `sendWorkspaceFileToCurrentChat`: reserves, sends, settles, and projects the delivery.
 *
 * Key constructs:
 * - The durable reservation precedes Telegram; a confirmed send is never repeated for bookkeeping.
 * - Tool deliveries bypass Telegram channel events, so confirmed group deliveries are projected into
 *   the group timeline here and bound to a reply route before a participant can answer them.
 * - A voice note replaces the final text reply, so in a private chat it is projected into the
 *   conversation timeline exactly like the channel projects a delivered answer.
 */
import { basename } from "node:path";

import type { ToolContext } from "eve/tools";

import { AppError, isAppError } from "../app-error.js";
import { conversationTimelineRepository } from "../conversation-timeline-repository.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "../sessions/session-context.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../workspaces/workspace-context.js";
import { workspaceFileDeliveryRepository } from "../workspaces/workspace-file-delivery-repository.js";
import type { WorkspaceScope } from "../workspaces/workspace-repository.js";
import {
  deliverWorkspaceFile,
  type WorkspaceFilePresentation,
} from "./telegram-workspace-file-delivery.js";

export interface WorkspaceFileChatDeliveryInput {
  caption?: string;
  path: string;
  presentation: WorkspaceFilePresentation;
  scope: WorkspaceScope;
  /** Timeline text for a delivery whose content is speech rather than a readable attachment. */
  timelineText?: string;
}

function currentForumTopicId(ctx: ToolContext): string | undefined {
  const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
  if (forumTopicId !== undefined &&
    (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))) {
    throw new AppError(
      "AGENT_TELEGRAM_FORUM_TOPIC_INVALID",
      "Не удалось определить тему для истории отправленного файла",
    );
  }
  return forumTopicId;
}

function stringAttribute(ctx: ToolContext, name: string): string | null {
  const value = ctx.session.auth.current?.attributes[name];
  return typeof value === "string" ? value : null;
}

export async function sendWorkspaceFileToCurrentChat(
  input: WorkspaceFileChatDeliveryInput,
  ctx: ToolContext,
) {
  const auth = requireWorkspaceAuthorization(ctx);
  const target = requireTelegramDeliveryTarget(ctx);
  const forumTopicId = currentForumTopicId(ctx);
  const reservation = await workspaceFileDeliveryRepository.begin(auth, {
    ...target,
    operationKey: ctx.callId,
    path: input.path,
    presentation: input.presentation,
    scope: input.scope,
  });
  const replayed = reservation.status === "completed";
  let persistenceCompleted = replayed;
  let delivery: { telegramMessageId: string };
  if (replayed) {
    delivery = { telegramMessageId: reservation.telegramMessageId };
  } else {
    try {
      delivery = await deliverWorkspaceFile({
        bytes: reservation.bytes,
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        ...target,
        fileName: basename(reservation.file.path),
        mediaType: reservation.file.mediaType,
        presentation: input.presentation,
      });
    } catch (error) {
      // Definitive validation/provider failures may be retried only through a new user request.
      if (isAppError(error) && error.code !== "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS") {
        await workspaceFileDeliveryRepository.fail(ctx.callId, error.code);
      }
      throw error;
    }
    try {
      await workspaceFileDeliveryRepository.complete(ctx.callId, delivery.telegramMessageId);
      persistenceCompleted = true;
    } catch (error) {
      // Telegram confirmed delivery, so a bookkeeping error must not turn into a retryable send.
      console.error(JSON.stringify({
        code: "AGENT_WORKSPACE_FILE_COMPLETION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        telegramMessageId: delivery.telegramMessageId,
      }));
    }
  }

  const fileName = basename(reservation.file.path);
  const contentText = input.timelineText ?? (input.caption?.trim() || `Отправлен файл «${fileName}».`);
  const conversationId = stringAttribute(ctx, "telegramConversationId");
  const privateVoiceReply = auth.groupId === null && input.presentation === "voice" &&
    conversationId !== null;
  let projectionCompleted = true;
  if (auth.groupId !== null || privateVoiceReply) {
    const sessionId = applicationSessionId(ctx);
    const replyToEntryId = stringAttribute(ctx, "telegramTimelineEntryId");
    try {
      if (auth.groupId !== null) {
        await telegramGroupJournalRepository.recordAgentResponse({
          applicationSessionId: sessionId,
          // The timeline stores readable attachments only; a voice note is kept as its spoken text.
          ...(input.presentation === "voice"
            ? {}
            : {
              attachment: {
                fileName,
                kind: input.presentation,
                mediaType: reservation.file.mediaType,
                size: reservation.bytes.byteLength,
              },
            }),
          contentText,
          deliveredAt: new Date(),
          groupId: auth.groupId,
          messageThreadId: forumTopicId ?? null,
          replyToEntryId,
          telegramMessageIds: [delivery.telegramMessageId],
        });
      } else {
        await conversationTimelineRepository.recordAgentResponse({
          applicationSessionId: sessionId,
          contentText,
          conversationId: conversationId!,
          deliveredAt: new Date(),
          messageThreadId: null,
          replyToEntryId,
          telegramMessageIds: [delivery.telegramMessageId],
        });
      }
      await registerTelegramMessageRoutes({
        applicationSessionId: sessionId,
        chatId: target.chatId,
        messageIds: [delivery.telegramMessageId],
        ...(target.messageThreadId === undefined
          ? {}
          : { messageThreadId: target.messageThreadId }),
      });
    } catch (error) {
      // Telegram already confirmed the side effect; surfacing an error would invite a duplicate send.
      projectionCompleted = false;
      console.error(JSON.stringify({
        code: "AGENT_WORKSPACE_FILE_PROJECTION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        telegramMessageId: delivery.telegramMessageId,
      }));
    }
  }
  return {
    delivered: true,
    path: reservation.file.path,
    persistenceCompleted,
    projectionCompleted,
    replayed,
    retryable: false,
    scope: reservation.file.scope,
    sideEffectStatus: "completed" as const,
    telegramMessageId: delivery.telegramMessageId,
  };
}
