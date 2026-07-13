/**
 * Consolidated long-term memory mutation tool.
 *
 * Export:
 * - `manage_memory` routes explicit edit, delete, and immediate undo actions.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAllowedMemoryContent } from "../lib/memory-content-policy.js";
import { requireMemoryAuthorization } from "../lib/memory-context.js";
import { memoryRepository } from "../lib/memory-repository.js";

const memoryIdSchema = z.string().uuid();
const manageMemorySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    content: z.string().min(1).max(4_000),
    id: memoryIdSchema,
    kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]).optional(),
    sensitivity: z.enum(["normal", "sensitive"]).optional(),
  }).strict(),
  z.object({ action: z.literal("delete"), id: memoryIdSchema }).strict(),
  z.object({ action: z.literal("undo"), id: memoryIdSchema }).strict(),
]);

export default defineTool({
  approval: ({ session, toolInput }) => {
    // Undo is the immediate reversal offered after creation; edit and delete remain confirmation-gated.
    if (toolInput?.action === "undo") return "not-applicable";
    return session.auth.current?.attributes.telegramChatType === "private"
      ? "user-approval"
      : "not-applicable";
  },
  description:
    "Управлять доступной долговременной памятью: исправить запись, удалить её или отменить только что выполненное сохранение.",
  inputSchema: manageMemorySchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    if (input.action === "edit") {
      const { action: _action, ...values } = input;
      return await memoryRepository.update(authorization, {
        ...values,
        content: requireAllowedMemoryContent(input.content),
        operationKey: ctx.callId,
      });
    }

    return await memoryRepository.delete(authorization, input.id, ctx.callId);
  },
});
