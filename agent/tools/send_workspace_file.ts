/**
 * Workspace-to-Telegram file sender tool.
 *
 * Export:
 * - Eve `send_workspace_file` tool with current-scope authorization and durable delivery guard.
 */
import { basename } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { isAppError } from "../lib/app-error.js";
import { scanAttachmentForMalware } from "../lib/attachments/clamav-scanner.js";
import { deliverWorkspaceFile } from "../lib/attachments/telegram-workspace-file-delivery.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../lib/workspaces/workspace-context.js";
import { workspaceFileDeliveryRepository } from "../lib/workspaces/workspace-file-delivery-repository.js";

export default defineTool({
  description: "Отправить файл из доступного workspace в текущий Telegram-чат или тему.",
  inputSchema: z.object({
    caption: z.string().max(1_024).optional(),
    path: z.string().min(1).max(512),
    presentation: z.enum(["document", "photo"]),
    scope: z.enum(["personal", "family", "group"]),
  }),
  async execute(input, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    const target = requireTelegramDeliveryTarget(ctx);
    const reservation = await workspaceFileDeliveryRepository.begin(auth, {
      ...target,
      operationKey: ctx.callId,
      path: input.path,
      presentation: input.presentation,
      scope: input.scope,
    });
    if (reservation.status === "completed") {
      return { delivered: true, replayed: true, telegramMessageId: reservation.telegramMessageId };
    }

    let delivery: { telegramMessageId: string };
    try {
      await scanAttachmentForMalware(reservation.bytes);
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
    await workspaceFileDeliveryRepository.complete(ctx.callId, delivery.telegramMessageId);
    return {
      delivered: true,
      path: reservation.file.path,
      replayed: false,
      scope: reservation.file.scope,
      telegramMessageId: delivery.telegramMessageId,
    };
  },
});
