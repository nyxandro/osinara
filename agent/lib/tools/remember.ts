/**
 * Long-term memory creation tool.
 *
 * Export:
 * - Eve `remember` tool for one main-agent source-backed claim and optional atomic thread action.
 */
import { defineTool } from "eve/tools";
import { AppError, isAppError } from "../app-error.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization, requireWritableScope } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { logMemoryWriteEvent } from "../memory-observability.js";
import { resolveMemoryTurnSource } from "../memory-turn-source.js";
import { toModelMemory } from "../model-memory.js";
import { rememberInputSchema } from "../remember-contract.js";

interface RememberToolResult {
  item: ReturnType<typeof toModelMemory>;
  /** Set when an existing record was reinforced instead of creating a new one. */
  reinforced?: true;
  thread?: NonNullable<Awaited<ReturnType<typeof memoryRepository.create>>["thread"]>;
  undoAvailable: boolean;
}

export default defineTool({
  description: [
    "Сохранить одну устойчивую запись, которую ты сама определила только из проверенного сообщения текущего хода; не сохраняй предположения и одноразовые запросы.",
    "Обычный payload: {\"basis\":\"user_requested\",\"content\":\"...\",\"kind\":\"fact\",\"scope\":\"personal\",\"sensitivity\":\"normal\",\"subject\":{\"kind\":\"current_author\"}}.",
    "В группе sourceSequence выбирает ровно одно сообщение видимой дельты. Для существующей нити используй thread.action=attach и threadRef только из list/search/read_memory_thread; thread.action=create создаёт нить атомарно.",
    "Результат содержит item.memoryRef и optional thread; для немедленной отмены доступен manage_memory с action undo. Не пересказывай пользователю служебные поля результата.",
    "При ошибке AGENT_MEMORY_NEAR_DUPLICATE один раз повтори вызов с reinforces (то же самое), attribute (факт изменился) или distinct=true (другой факт).",
  ].join(" "),
  inputSchema: rememberInputSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    const requestedSourceKind = input.sourceSequence === undefined ? "current" : "delta";
    let source: Awaited<ReturnType<typeof resolveMemoryTurnSource>> | null = null;
    let item: Awaited<ReturnType<typeof memoryRepository.create>>;
    if (input.reinforces !== undefined) {
      // The writer confirmed an existing record says the same; nothing new is inserted.
      const reinforced = await memoryRepository.reinforceByRef(authorization, {
        memoryRef: input.reinforces,
        provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
      });
      console.info(JSON.stringify({
        code: "AGENT_MEMORY_REINFORCED",
        reason: "remember_reinforces",
        refs: [reinforced.memoryRef],
      }));
      const result: RememberToolResult = { item: toModelMemory(reinforced), reinforced: true, undoAvailable: false };
      return result;
    }
    try {
      source = await resolveMemoryTurnSource(ctx, authorization, input.sourceSequence);
      const reviewWrite = source.isReview;
      if (reviewWrite && (input.sensitivity !== "normal" || input.basis !== "agent_inferred" ||
        input.sourceSequence === undefined)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_INPUT_INVALID",
          "Тихая проверка сохраняет только normal-память с конкретным sourceSequence",
        );
      }
      item = await memoryRepository.create(authorization, {
        ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        // A request to save another participant's delta message is not that author's endorsement.
        confirmation: input.basis === "user_requested" && source.isCurrent
          ? "user_confirmed"
          : "model_high",
        content: requireAllowedMemoryContent(input.content),
        ...(input.distinct === undefined ? {} : { distinct: input.distinct }),
        explicitSource: {
          conversationId: source.conversationId,
          subject: input.subject,
          timelineEntryId: source.timelineEntryId,
        },
        kind: input.kind,
        operationKey: ctx.callId,
        provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
        systemActor: reviewWrite,
        scope,
        sensitivity: input.sensitivity,
        source: `eve:${ctx.session.id}:${ctx.session.turn.id}`,
        sourceEventId: source.sourceMessageId,
        ...(source.messageThreadId === null ? {} : { messageThreadId: source.messageThreadId }),
        ...(input.thread === undefined ? {} : { thread: input.thread }),
      });
    } catch (error) {
      const errorCode = isAppError(error)
        ? error.code
        : typeof error === "object" && error !== null &&
            "code" in error && typeof error.code === "string"
          ? error.code
          : "AGENT_MEMORY_WRITE_UNEXPECTED";
      logMemoryWriteEvent({
        code: "AGENT_MEMORY_WRITE_FAILED",
        errorCode,
        scope,
        sourceKind: source?.isCurrent === true ? "current" : requestedSourceKind,
        threadAction: input.thread?.action ?? "none",
      });
      throw error;
    }
    logMemoryWriteEvent({
      code: "AGENT_MEMORY_WRITE_SUCCEEDED",
      scope,
      sourceKind: source.isCurrent ? "current" : "delta",
      threadAction: item.thread?.action ?? "none",
    });
    const result: RememberToolResult = {
      item: toModelMemory(item),
      ...(item.thread === undefined ? {} : { thread: item.thread }),
      // Machine-readable only: a sentence here tends to be echoed to the user verbatim.
      undoAvailable: true,
    };
    return result;
  },
});
