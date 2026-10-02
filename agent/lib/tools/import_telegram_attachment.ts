/**
 * Lazy registered-group Telegram attachment import tool.
 *
 * Export:
 * - `import_telegram_attachment` materializes one authorized family or external journal reference.
 * - External imports expose the canonical sandbox path accepted by guarded file tools.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { materializeTelegramAttachment } from "../attachments/telegram-attachment-materializer.js";
import {
  requireInputRecord,
  requireOnlyFields,
  requiredUuid,
} from "../tool-input-validation.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_ATTACHMENT_IMPORT_INPUT_INVALID";
const TOP_LEVEL_FIELDS = ["attachmentId"] as const;
const EXTERNAL_GROUP_SANDBOX_ROOT = "/workspace/group";

export default defineTool({
  description: [
    "Когда использовать: скачать по явной просьбе одно разрешённое вложение зарегистрированной Telegram-группы в её workspace.",
    "Не использовать: не передавай придуманный или полученный в другом чате attachmentId.",
    "Вход: attachmentId только из <telegram_attachment_refs> или журнала текущей группы.",
    "Результат: метаданные вложения и path, который затем передай в read_file или inspect_workspace_image.",
    "Ошибка: при NOT_FOUND заново получи attachmentId через list_telegram_attachments или историю; transport failure автоматически не повторяй.",
  ].join(" "),
  inputSchema: z.object({
    attachmentId: z.uuid().describe("Обязательный UUID вложения из <telegram_attachment_refs> или журнала текущей группы"),
  }).strict(),
  async execute(input, ctx) {
    const payload = requireInputRecord(
      input,
      "import_telegram_attachment",
      INPUT_ERROR_CODE,
    );
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "import_telegram_attachment", INPUT_ERROR_CODE);
    const attachmentId = requiredUuid(
      payload,
      "attachmentId",
      INPUT_ERROR_CODE,
      "ссылка на вложение из текущей зарегистрированной группы",
    );
    const authorization = requireWorkspaceAuthorization(ctx);
    const attachment = await materializeTelegramAttachment(authorization, attachmentId);

    // Restricted file wrappers require an absolute path under the exact group mount.
    if (authorization.groupType === "external") {
      return {
        ...attachment,
        path: `${EXTERNAL_GROUP_SANDBOX_ROOT}/${attachment.path}`,
      };
    }

    return attachment;
  },
});
