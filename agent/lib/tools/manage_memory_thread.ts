/**
 * Explicit authoritative memory-thread lifecycle tool.
 *
 * Export:
 * - `manage_memory_thread`: completes or reactivates an authorized thread with replay protection.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryThreadLifecycleRepository } from "../memory-thread-lifecycle-repository.js";
import { THREAD_ENTRY_REF_PATTERN, THREAD_REF_PATTERN } from "../memory-thread-query-repository.js";

const OUTCOME_REF_PATTERN = /^outcome_[0-9a-f]{32}$/u;
const inputSchema = z.object({
  action: z.enum(["complete", "reactivate"]).describe("Одна lifecycle-операция"),
  authority: z.enum(["current_user_statement", "confirmed_outcome", "formal_goal_condition"]).optional()
    .describe("Обязательно только для complete"),
  outcomeRef: z.string().regex(OUTCOME_REF_PATTERN).optional()
    .describe("Только подтверждённый ref из текущего outcome context; не нужен для current_user_statement"),
  sourceEntryRefs: z.array(z.string().regex(THREAD_ENTRY_REF_PATTERN)).min(1).max(20).optional()
    .describe("Для complete: refs доказательств только из read_memory_thread"),
  threadRef: z.string().regex(THREAD_REF_PATTERN).describe("Opaque ref только из list/search/read_memory_thread"),
}).strict();

function verifiedTurn(ctx: Parameters<typeof requireMemoryAuthorization>[0]) {
  const attributes = ctx.session.auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;
  if (typeof conversationId !== "string" || typeof timelineEntryId !== "string") {
    throw new AppError(
      "AGENT_MEMORY_THREAD_AUTHORITY_INVALID",
      "Не удалось подтвердить текущее сообщение для изменения нити памяти",
    );
  }
  return { conversationId, timelineEntryId };
}

export default defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  description: [
    "Явно завершить или реактивировать нить памяти.",
    "complete разрешён только после проверенного текущего заявления пользователя, confirmed outcome или formal goal condition и требует sourceEntryRefs из read_memory_thread.",
    "reactivate используй только когда пользователь прямо просит продолжить именно завершённую нить; новая цель обычно создаёт новый subthread.",
    "Payload reactivate: {\"action\":\"reactivate\",\"threadRef\":\"thread_...\"}. Payload complete с текущим заявлением: {\"action\":\"complete\",\"authority\":\"current_user_statement\",\"sourceEntryRefs\":[\"entry_...\"],\"threadRef\":\"thread_...\"}.",
    "Результат возвращает актуальное состояние нити; NOT_FOUND требует заново получить threadRef.",
  ].join(" "),
  inputSchema,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const turn = verifiedTurn(ctx);
    if (input.action === "reactivate") {
      if (input.authority !== undefined || input.outcomeRef !== undefined ||
        input.sourceEntryRefs !== undefined) {
        throw new AppError(
          "AGENT_MEMORY_THREAD_INPUT_INVALID",
          "Для reactivate нужны только action и threadRef",
        );
      }
      return await memoryThreadLifecycleRepository.reactivate(auth, {
        operationKey: ctx.callId,
        threadRef: input.threadRef,
        turn,
      });
    }

    if (!input.authority || !input.sourceEntryRefs) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_INPUT_INVALID",
        "Для complete нужны authority и sourceEntryRefs",
      );
    }
    const requiresOutcome = input.authority !== "current_user_statement";
    if (requiresOutcome !== (input.outcomeRef !== undefined)) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_INPUT_INVALID",
        "Подтверждённый outcomeRef обязателен только для outcome/formal authority",
      );
    }
    const authority = input.authority === "current_user_statement"
      ? { kind: "current_user_statement" as const }
      : { kind: input.authority, outcomeRef: input.outcomeRef! };
    return await memoryThreadLifecycleRepository.complete(auth, {
      authority,
      operationKey: ctx.callId,
      sourceEntryRefs: input.sourceEntryRefs,
      threadRef: input.threadRef,
      turn,
    });
  },
});
