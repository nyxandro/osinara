/**
 * Long-term memory creation tool.
 *
 * Export:
 * - Eve `remember` tool with scoped writes, conditional approval, and replay protection.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAllowedMemoryContent } from "../lib/memory-content-policy.js";
import { requireMemoryAuthorization, requireWritableScope } from "../lib/memory-context.js";
import { memoryRepository } from "../lib/memory-repository.js";
import { resolveSessionCaller } from "../lib/session-auth.js";

const memoryCreateSchema = z.object({
  confirmationMode: z
    .enum(["automatic", "explicit"])
    .describe("explicit только когда пользователь прямо попросил сохранить это сведение"),
  content: z.string().min(1).max(4_000),
  kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]),
  scope: z.enum(["personal", "family", "group"]),
  sensitivity: z.enum(["normal", "sensitive"]),
});

export default defineTool({
  approval: ({ session, toolInput }) => {
    // Sensitive data and disclosure from a private chat into family memory require explicit consent.
    const input = toolInput as z.infer<typeof memoryCreateSchema> | undefined;
    const privateFamilyWrite =
      input?.scope === "family" && session.auth.current?.attributes.telegramChatType === "private";
    return input?.sensitivity === "sensitive" || privateFamilyWrite
      ? "user-approval"
      : "not-applicable";
  },
  description:
    "Сохранить одну запись долговременной памяти: устойчивый факт, профильное сведение, предпочтение, содержимое, которое пользователь просит запомнить, или итог решения. Не сохранять одноразовые запросы и предположения.",
  inputSchema: memoryCreateSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    const caller = resolveSessionCaller(ctx);
    const approvedByPolicy =
      input.sensitivity === "sensitive" ||
      (scope === "family" &&
        caller?.attributes.telegramChatType === "private");
    const item = await memoryRepository.create(authorization, {
      confirmation:
        input.confirmationMode === "explicit" || approvedByPolicy
          ? "user_confirmed"
          : "model_high",
      content: requireAllowedMemoryContent(input.content),
      kind: input.kind,
      operationKey: ctx.callId,
      scope,
      sensitivity: input.sensitivity,
      source: `eve:${ctx.session.id}:${ctx.session.turn.id}`,
      sourceEventId:
        typeof caller?.attributes.telegramMessageId === "string"
          ? caller.attributes.telegramMessageId
          : undefined,
      messageThreadId:
        typeof caller?.attributes.telegramMessageThreadId === "string"
          ? caller.attributes.telegramMessageThreadId
          : undefined,
    });
    return {
      item,
      notice: `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и id ${item.id}.`,
    };
  },
});
