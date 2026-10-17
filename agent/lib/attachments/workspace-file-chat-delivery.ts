/**
 * Exactly-once delivery of one workspace file into the current verified Telegram chat.
 *
 * Exports:
 * - `WorkspaceFileChatDeliveryInput`: file, rendering, and timeline projection of one delivery.
 * - `sendWorkspaceFileToCurrentChat`: reserves, sends, settles, and projects the delivery.
 *
 * Key constructs:
 * - The durable reservation precedes Telegram; a confirmed send is never repeated for bookkeeping.
 * - The confirmed delivery is projected into the conversation history; a voice note replaces the
 *   final text reply, so in a private chat it is projected like a delivered answer.
 */
import { basename } from "node:path";

import type { ToolContext } from "../../runtime/tool.js";

import { isAppError } from "../app-error.js";
import {
  recordToolDeliveryInTimeline,
  toolDeliveryTimelineTarget,
} from "../telegram-tool-delivery-timeline.js";
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

export async function sendWorkspaceFileToCurrentChat(
  input: WorkspaceFileChatDeliveryInput,
  ctx: ToolContext,
) {
  const auth = requireWorkspaceAuthorization(ctx);
  const target = requireTelegramDeliveryTarget(ctx);
  const timelineTarget = toolDeliveryTimelineTarget(ctx);
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
  const projectionCompleted = await recordToolDeliveryInTimeline(ctx, timelineTarget, {
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
    contentText: input.timelineText ?? (input.caption?.trim() || `Отправлен файл «${fileName}».`),
    failureCode: "AGENT_WORKSPACE_FILE_PROJECTION_FAILED",
    replacesAnswer: input.presentation === "voice",
    telegramMessageId: delivery.telegramMessageId,
  });
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
