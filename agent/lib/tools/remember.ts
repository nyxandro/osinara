/**
 * Long-term memory creation tool.
 *
 * Export:
 * - `remember` tool for one main-agent source-backed claim and optional atomic thread action.
 */
import { defineTool } from "../../runtime/tool.js";
import { AppError, isAppError } from "../app-error.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import {
  requireMemoryAuthorization,
  requireWritableScope,
  type MemoryScope,
} from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { logMemoryWriteEvent } from "../memory-observability.js";
import { bindSourceAuthorLabel } from "../memory-subject-author-label.js";
import { resolveMemoryTurnSource } from "../memory-turn-source.js";
import { toModelMemory } from "../model-memory.js";
import {
  MemoryNeighbourRefusal,
  memoryNeighbourRefusalResult,
} from "../memory-neighbour-gate.js";
import { rememberInputSchema } from "../remember-contract.js";
import { memoryReviewBatchId } from "../memory-review/memory-review-session.js";

export default defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  description: [
    "Save one specific fact only from the verified message of the current turn: a fact, a preference, first-hand experience, an event, a plan or a useful link with context. Do not require special importance or a request to remember; do not save guesses or requests without meaningful facts.",
    "When selecting on your own use basis=agent_inferred, on a direct request to save the fact basis=user_requested. An example of saving on your own: {\"basis\":\"agent_inferred\",\"content\":\"...\",\"kind\":\"fact\",\"scope\":\"personal\",\"sensitivity\":\"normal\",\"subject\":{\"kind\":\"current_author\"}}.",
    "In a group sourceSequence picks exactly one message of the visible delta. For an existing thread use thread.action=attach with a threadRef only from list/search/read_memory_thread; thread.action=create creates a thread atomically.",
    "For an event with a known date set occurredOn: the day it happened, not the day of the conversation. Do not guess the date: if it is not known from the message, leave the field empty.",
    "For a property that changes over time (a preference, a workplace, an address) set attribute, a short name of the property. A new record of the same subject with the same attribute moves the previous one into history; the previous one is not deleted and is visible in the memory list.",
    "If memory already holds a fact close in meaning about the same subject, the call is refused with AGENT_MEMORY_SIMILAR_RECORD_EXISTS and a list of such records: read them and decide yourself whether to update the existing one, set attribute, or list them in distinctFrom and save separately.",
    "The result contains item.memoryRef, an optional thread, supersededRefs for replaced versions and a notice for an immediate undo.",
  ].join(" "),
  inputSchema: rememberInputSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const requestedSourceKind = input.sourceSequence === undefined ? "current" : "delta";
    let scope: MemoryScope;
    try {
      scope = requireWritableScope(authorization, input.scope);
    } catch (error) {
      // A refused scope is a failed write like any other: the reason lived only in an unstructured
      // framework stack, so a background run losing a fact left nothing to search the log by.
      logMemoryWriteEvent({
        code: "AGENT_MEMORY_WRITE_FAILED",
        errorCode: isAppError(error) ? error.code : "AGENT_MEMORY_WRITE_UNEXPECTED",
        scope: input.scope,
        sourceKind: requestedSourceKind,
        threadAction: input.thread?.action ?? "none",
      });
      throw error;
    }
    let source: Awaited<ReturnType<typeof resolveMemoryTurnSource>> | null = null;
    let item: Awaited<ReturnType<typeof memoryRepository.create>>;
    let authorLabelBound = false;
    try {
      source = await resolveMemoryTurnSource(ctx, authorization, input.sourceSequence);
      // Bound before anything reads the subject: the duplicate check, the replay key and the
      // profile then see the verified author, exactly as if the model had said current_author.
      const subject = bindSourceAuthorLabel(input.subject, source.author);
      authorLabelBound = subject !== input.subject;
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
          subject,
          timelineEntryId: source.timelineEntryId,
        },
        kind: input.kind,
        operationKey: ctx.callId,
        provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
        systemActor: reviewWrite,
        scope,
        sensitivity: input.sensitivity,
        source: `turn:${ctx.session.id}:${ctx.session.turn.id}`,
        sourceEventId: source.sourceMessageId,
        ...(source.messageThreadId === null ? {} : { messageThreadId: source.messageThreadId }),
        ...(input.thread === undefined ? {} : { thread: input.thread }),
      });
    } catch (error) {
      // A stop for review is the product working, not a failure: answered, not thrown. Thrown, it
      // would be logged by the framework with its whole payload, and the neighbours it names are
      // memory content — it would leave the application for the log store on every refusal.
      if (error instanceof MemoryNeighbourRefusal) {
        logMemoryWriteEvent({
          code: "AGENT_MEMORY_WRITE_DEFERRED",
          errorCode: "AGENT_MEMORY_SIMILAR_RECORD_EXISTS",
          scope,
          sourceKind: source?.isCurrent === true ? "current" : requestedSourceKind,
          threadAction: input.thread?.action ?? "none",
        });
        // The gate runs inside the write, so the source is resolved by the time it refuses.
        return memoryNeighbourRefusalResult(error, { editAvailable: source !== null && !source.isReview });
      }
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
      ...(authorLabelBound ? { authorLabelBound: true as const } : {}),
      code: "AGENT_MEMORY_WRITE_SUCCEEDED",
      scope,
      sourceKind: source.isCurrent ? "current" : "delta",
      threadAction: item.thread?.action ?? "none",
    });
    return {
      item: toModelMemory(item),
      ...(item.supersededRefs === undefined ? {} : { supersededRefs: item.supersededRefs }),
      ...(item.thread === undefined ? {} : { thread: item.thread }),
      // The silent review has no manage_memory, so an undo hint would send it after a missing tool.
      notice: source.isReview
        ? `Сохранено в область «${scope}».`
        : `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и memoryRef ${item.memoryRef}.`,
    };
  },
});
