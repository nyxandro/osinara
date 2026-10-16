/**
 * Workspace-to-Telegram file sender tool.
 *
 * Export:
 * - `send_workspace_file` tool with current-scope authorization and durable delivery guard.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { sendWorkspaceFileToCurrentChat } from "../attachments/workspace-file-chat-delivery.js";

export default defineTool({
  description: [
    "When to use: send an already existing file from the available workspace to the current Telegram chat or topic.",
    "When not to use: it does not create a file and does not accept an absolute sandbox path.",
    "Input: path relative to the root of the chosen scope, for example reports/result.pdf; do not prepend personal, family or group to the path. presentation chooses document or photo.",
    "Result: delivered=true, telegramMessageId, path, scope and replayed; persistenceCompleted=false or projectionCompleted=false means the file has already been sent but the internal accounting was not fully updated.",
    "Error: if sideEffectStatus=unknown or completed, do not send the file again without a new user request.",
  ].join(" "),
  inputSchema: z.object({
    caption: z.string().max(1_024).optional().describe("An optional Telegram caption"),
    path: z.string().min(1).max(512).describe("A relative path inside the chosen scope"),
    presentation: z.enum(["document", "photo"]).describe("How to send it in Telegram"),
    scope: z.enum(["personal", "family", "group"]).describe("The workspace the path is relative to"),
  }).strict(),
  async execute(input, ctx) {
    return await sendWorkspaceFileToCurrentChat(input, ctx);
  },
});
