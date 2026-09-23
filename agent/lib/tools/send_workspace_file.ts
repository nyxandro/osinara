/**
 * Workspace-to-Telegram file sender tool.
 *
 * Export:
 * - Eve `send_workspace_file` tool with current-scope authorization and durable delivery guard.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { sendWorkspaceFileToCurrentChat } from "../attachments/workspace-file-chat-delivery.js";

export default defineTool({
  description: [
    "Когда использовать: отправить уже существующий файл из доступного workspace в текущий Telegram-чат или тему.",
    "Не использовать: не создаёт файл и не принимает абсолютный sandbox path.",
    "Вход: path относительно корня выбранного scope, например reports/result.pdf; не добавляй personal, family или group в начало пути. presentation выбирает document или photo.",
    "Результат: delivered=true, telegramMessageId, path, scope и replayed; persistenceCompleted=false или projectionCompleted=false означает, что файл уже отправлен, но служебный учёт обновился не полностью.",
    "Ошибка: если sideEffectStatus=unknown или completed, не отправляй файл повторно без нового запроса пользователя.",
  ].join(" "),
  inputSchema: z.object({
    caption: z.string().max(1_024).optional().describe("Необязательная подпись Telegram"),
    path: z.string().min(1).max(512).describe("Относительный путь внутри выбранного scope"),
    presentation: z.enum(["document", "photo"]).describe("Способ отправки в Telegram"),
    scope: z.enum(["personal", "family", "group"]).describe("Workspace, относительно которого задан path"),
  }).strict(),
  async execute(input, ctx) {
    return await sendWorkspaceFileToCurrentChat(input, ctx);
  },
});
