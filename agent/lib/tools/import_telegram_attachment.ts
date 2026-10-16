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
    "When to use: on an explicit request, download one permitted attachment of a registered Telegram group into its workspace.",
    "When not to use: do not pass an invented attachmentId or one obtained in another chat.",
    "Input: an attachmentId only from <telegram_attachment_refs> or the log of the current group.",
    "Result: the attachment metadata and a path, which you then pass to read_file or inspect_workspace_image.",
    "Error: on NOT_FOUND get the attachmentId again through list_telegram_attachments or the history; do not repeat a transport failure automatically.",
  ].join(" "),
  inputSchema: z.object({
    attachmentId: z.uuid().describe("The required attachment UUID from <telegram_attachment_refs> or the log of the current group"),
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
