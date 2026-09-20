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
import { memoryReviewBatchId } from "../memory-review/memory-review-session.js";

export default defineTool({
  description: [
    "Сохранить одно конкретное сведение только из проверенного сообщения текущего хода: факт, предпочтение, личный опыт, событие, план или полезную ссылку с контекстом. Не требуй особой важности или просьбы запомнить; не сохраняй догадки и поручения без содержательных фактов.",
    "При самостоятельном отборе используй basis=agent_inferred, при прямой просьбе сохранить сведение basis=user_requested. Пример самостоятельного сохранения: {\"basis\":\"agent_inferred\",\"content\":\"...\",\"kind\":\"fact\",\"scope\":\"personal\",\"sensitivity\":\"normal\",\"subject\":{\"kind\":\"current_author\"}}.",
    "В группе sourceSequence выбирает ровно одно сообщение видимой дельты. Для существующей нити используй thread.action=attach и threadRef только из list/search/read_memory_thread; thread.action=create создаёт нить атомарно.",
    "Для события с известной датой задавай occurredOn: это день, когда оно произошло, а не день разговора. Дату не угадывай: не известна из сообщения, оставь поле пустым.",
    "Для свойства, которое со временем меняется (предпочтение, место работы, адрес), задавай attribute — короткое имя свойства. Новая запись того же субъекта с тем же attribute переводит прежнюю в историю; прежняя не удаляется и видна в списке памяти.",
    "Если в памяти уже есть близкое по смыслу сведение о том же субъекте, вызов отклоняется с AGENT_MEMORY_SIMILAR_RECORD_EXISTS и списком таких записей: прочитай их и реши сама — обновить существующую, задать attribute или перечислить их в distinctFrom и сохранить отдельно.",
    "Результат содержит item.memoryRef, optional thread, supersededRefs для замещённых версий и notice для немедленного undo.",
  ].join(" "),
  inputSchema: rememberInputSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    const requestedSourceKind = input.sourceSequence === undefined ? "current" : "delta";
    let source: Awaited<ReturnType<typeof resolveMemoryTurnSource>> | null = null;
    let item: Awaited<ReturnType<typeof memoryRepository.create>>;
    try {
      source = await resolveMemoryTurnSource(ctx, authorization, input.sourceSequence);
      const reviewWrite = source.isReview;
      const reviewBatchId = reviewWrite ? memoryReviewBatchId(ctx) : null;
      if (reviewWrite && !reviewBatchId) throw new AppError(
        "AGENT_MEMORY_REVIEW_CONTEXT_INVALID", "Не удалось подтвердить текущий пакет проверки памяти",
      );
      if (reviewWrite && (input.sensitivity !== "normal" || input.basis !== "agent_inferred" ||
        input.sourceSequence === undefined)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_INPUT_INVALID",
          "Тихая проверка сохраняет только normal-память с конкретным sourceSequence",
        );
      }
      item = await memoryRepository.create(authorization, {
        ...(reviewBatchId === null ? {} : { memoryReviewBatchId: reviewBatchId }),
        ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
        ...(input.distinctFrom === undefined ? {} : { distinctFrom: input.distinctFrom }),
        ...(input.occurredOn === undefined ? {} : { occurredOn: input.occurredOn }),
        // A request to save another participant's delta message is not that author's endorsement.
        confirmation: input.basis === "user_requested" && source.isCurrent
          ? "user_confirmed"
          : "model_high",
        content: requireAllowedMemoryContent(input.content),
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
    return {
      item: toModelMemory(item),
      ...(item.supersededRefs === undefined ? {} : { supersededRefs: item.supersededRefs }),
      ...(item.thread === undefined ? {} : { thread: item.thread }),
      notice: `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и memoryRef ${item.memoryRef}.`,
    };
  },
});
