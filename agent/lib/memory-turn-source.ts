/**
 * Turn-bound Telegram memory source authorization.
 *
 * Exports:
 * - `bindMemoryTurnSources`: persists the immutable source set at `turn.started`.
 * - `resolveMemoryTurnSource`: resolves current, visible-delta, or review-batch source for `remember`.
 * - `releaseMemoryTurnSources`: releases timeline retention at the terminal turn boundary.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryTurnSourceRepository } from "./memory-turn-source-repository.js";
import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

const POSITIVE_SEQUENCE_PATTERN = /^[1-9]\d*$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

type TurnContext = Pick<SessionContext, "session">;

function sourceError(reason: string): AppError {
  console.error(
    JSON.stringify({
      code: "AGENT_MEMORY_TURN_SOURCE_INVALID",
      reason,
    }),
  );
  return new AppError("AGENT_MEMORY_EXPLICIT_SOURCE_INVALID", "Не удалось подтвердить сообщение для сохранения памяти. Отправьте запрос ещё раз");
}

export async function bindMemoryTurnSources(ctx: TurnContext): Promise<void> {
  const attributes = ctx.session.auth.current?.attributes;
  const applicationSessionId = attributes?.applicationSessionId;
  const conversationId = attributes?.telegramConversationId;
  const currentTimelineEntryId = attributes?.telegramTimelineEntryId;
  const invokingActor = resolveTelegramSessionActor(ctx.session.auth);
  const memoryReviewBatchId = attributes?.memoryReviewBatchId;
  const memoryReviewSourceEntryIds = attributes?.memoryReviewSourceEntryIds;
  const visibleTimelineEntryIds = attributes?.telegramTimelineVisibleEntryIds;
  // Scheduled prompts have no verified Telegram message that could serve as memory evidence.
  if (typeof attributes?.scheduledRunId === "string" && attributes.scheduledRunId) return;

  // Eve resumes an approved tool in the same durable turn but supplies freshly revalidated callback
  // auth without replaying the original message metadata. Accept only the exact retained binding.
  const sourceAttributesAbsent =
    conversationId === undefined && currentTimelineEntryId === undefined && visibleTimelineEntryIds === undefined && memoryReviewBatchId === undefined && memoryReviewSourceEntryIds === undefined;
  if (
    typeof applicationSessionId === "string" &&
    invokingActor !== null &&
    sourceAttributesAbsent &&
    (await memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId,
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
      invokingActorId: invokingActor.id,
      invokingActorKind: invokingActor.kind,
    }))
  )
    return;

  const internalReview = memoryReviewBatchId !== undefined && currentTimelineEntryId === undefined;
  const present = [applicationSessionId, conversationId, currentTimelineEntryId, invokingActor, visibleTimelineEntryIds, memoryReviewBatchId, memoryReviewSourceEntryIds].filter((value) => value !== undefined).length;
  if (present === 0) return;
  if (internalReview) {
    if (
      typeof applicationSessionId !== "string" ||
      typeof conversationId !== "string" ||
      invokingActor === null ||
      typeof memoryReviewBatchId !== "string" ||
      !Array.isArray(memoryReviewSourceEntryIds) ||
      !memoryReviewSourceEntryIds.every((entryId) => typeof entryId === "string") ||
      visibleTimelineEntryIds !== undefined
    ) {
      throw sourceError("review_turn_attributes_invalid");
    }
    await memoryTurnSourceRepository.bindReview({
      applicationSessionId,
      conversationId,
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
      invokingActorId: invokingActor.id,
      invokingActorKind: invokingActor.kind,
      memoryReviewBatchId,
      sourceEntryIds: memoryReviewSourceEntryIds,
    });
    return;
  }
  if (
    typeof applicationSessionId !== "string" ||
    typeof conversationId !== "string" ||
    typeof currentTimelineEntryId !== "string" ||
    invokingActor === null ||
    !Array.isArray(visibleTimelineEntryIds) ||
    !visibleTimelineEntryIds.every((entryId) => typeof entryId === "string") ||
    (memoryReviewBatchId === undefined) !== (memoryReviewSourceEntryIds === undefined) ||
    (memoryReviewSourceEntryIds !== undefined && (!Array.isArray(memoryReviewSourceEntryIds) || !memoryReviewSourceEntryIds.every((entryId) => typeof entryId === "string")))
  ) {
    throw sourceError("turn_attributes_invalid");
  }
  await memoryTurnSourceRepository.bind({
    applicationSessionId,
    conversationId,
    currentTimelineEntryId,
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    invokingActorId: invokingActor.id,
    invokingActorKind: invokingActor.kind,
    ...(typeof memoryReviewBatchId === "string" ? { memoryReviewBatchId } : {}),
    ...(Array.isArray(memoryReviewSourceEntryIds)
      ? {
          memoryReviewSourceEntryIds: memoryReviewSourceEntryIds as string[],
        }
      : {}),
    visibleTimelineEntryIds,
  });
}

export async function resolveMemoryTurnSource(
  ctx: TurnContext,
  auth: MemoryAuthorization,
  sourceSequence?: string,
): Promise<{
  conversationId: string;
  isCurrent: boolean;
  isReview: boolean;
  messageThreadId: string | null;
  sourceMessageId: string;
  timelineEntryId: string;
}> {
  if (sourceSequence !== undefined && (!POSITIVE_SEQUENCE_PATTERN.test(sourceSequence) || BigInt(sourceSequence) > POSTGRES_BIGINT_MAX)) {
    throw sourceError("source_sequence_invalid");
  }
  const source = await memoryTurnSourceRepository.resolve({
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    sourceSequence: sourceSequence ?? null,
  });
  if (!source) throw sourceError("source_not_bound_to_turn");
  // An ordinary personal turn saves only its current message; the silent review of a personal
  // conversation is the one place where a historical sequence is a verified, batch-bound source.
  if (sourceSequence !== undefined && auth.groupId === null && !source.isReview) {
    throw sourceError("personal_delta_source_forbidden");
  }
  const expectedPartition = source.scope === "group" ? auth.groupId : source.scope === "personal" ? auth.userId : auth.familyId;
  if (
    (!source.isReview && (source.invokingActorId !== auth.telegramActorId || source.invokingActorKind !== auth.telegramActorKind)) ||
    source.scopePartitionKey !== expectedPartition ||
    !auth.scopes.includes(source.scope)
  ) {
    throw sourceError("source_authorization_mismatch");
  }
  return {
    conversationId: source.conversationId,
    isCurrent: source.isCurrent,
    isReview: source.isReview,
    messageThreadId: source.messageThreadId,
    sourceMessageId: source.sourceMessageId,
    timelineEntryId: source.timelineEntryId,
  };
}

export async function releaseMemoryTurnSources(ctx: TurnContext): Promise<void> {
  await memoryTurnSourceRepository.release(ctx.session.id, ctx.session.turn.id);
}
