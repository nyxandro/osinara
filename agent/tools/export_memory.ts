/**
 * Personal long-term memory export tool.
 *
 * Export:
 * - `export_memory` generates JSON and Markdown outside the model and delivers both to Telegram.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../lib/app-error.js";
import { requireMemoryAuthorization } from "../lib/memory-context.js";
import { formatMemoryExportFiles } from "../lib/memory-export.js";
import { memoryExportRepository } from "../lib/memory-export-repository.js";
import { deliverMemoryExportFiles } from "../lib/telegram-memory-export-delivery.js";

export default defineTool({
  description: "Экспортировать всю личную память пользователя в файлах JSON и Markdown.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const caller = ctx.session.auth.current;
    const chatId = caller?.attributes.telegramChatId;
    if (caller?.attributes.telegramChatType !== "private" || typeof chatId !== "string") {
      throw new AppError(
        "AGENT_MEMORY_EXPORT_SCOPE_DENIED",
        "Экспорт личной памяти доступен только в личном Telegram-чате",
      );
    }
    const records = await memoryExportRepository.begin(auth, ctx.callId);
    const files = formatMemoryExportFiles({
      exportedAt: new Date().toISOString(),
      records,
      schemaVersion: 1,
    });
    try {
      await deliverMemoryExportFiles({ chatId, ...files });
    } catch (error) {
      // A provider HTTP rejection is definitive; a network failure remains started to prevent duplicates.
      if (isAppError(error) && error.code === "AGENT_MEMORY_EXPORT_DELIVERY_FAILED") {
        await memoryExportRepository.fail(auth, ctx.callId, error.code);
      }
      throw error;
    }
    await memoryExportRepository.complete(auth, ctx.callId);
    return { delivered: true, formats: ["json", "markdown"], recordCount: records.length };
  },
});
