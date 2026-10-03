/**
 * Fingerprints of a turn's memory source binding, stored in `memory_turn_source_sets.binding_hash`.
 *
 * Exports:
 * - `turnSourceBindingHash`: a conversation turn's binding.
 * - `reviewSourceBindingHash`: a memory review turn's binding.
 *
 * A replayed bind compares its fingerprint with the stored one, so the serialized field names and
 * their order are a stored format: `eveSessionId` and `eveTurnId` stay until a data migration
 * recomputes the stored values.
 */
import { createHash } from "node:crypto";

import type { TelegramActorKind } from "./telegram-inbound-actor.js";

interface BindingCoordinates {
  applicationSessionId: string;
  conversationId: string;
  agentSessionId: string;
  agentTurnId: string;
  invokingActorId: string;
  invokingActorKind: TelegramActorKind;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function turnSourceBindingHash(
  input: BindingCoordinates & { currentTimelineEntryId: string; memoryReviewBatchId?: string },
  sortedEntryIds: readonly string[],
): string {
  return sha256({
    applicationSessionId: input.applicationSessionId,
    conversationId: input.conversationId,
    currentTimelineEntryId: input.currentTimelineEntryId,
    eveSessionId: input.agentSessionId,
    eveTurnId: input.agentTurnId,
    invokingActorId: input.invokingActorId,
    invokingActorKind: input.invokingActorKind,
    memoryReviewBatchId: input.memoryReviewBatchId ?? null,
    visibleTimelineEntryIds: sortedEntryIds,
  });
}

export function reviewSourceBindingHash(
  input: BindingCoordinates & { memoryReviewBatchId: string },
  sortedEntryIds: readonly string[],
): string {
  return sha256({
    applicationSessionId: input.applicationSessionId,
    conversationId: input.conversationId,
    eveSessionId: input.agentSessionId,
    eveTurnId: input.agentTurnId,
    invokingActorId: input.invokingActorId,
    invokingActorKind: input.invokingActorKind,
    memoryReviewBatchId: input.memoryReviewBatchId,
    sourceEntryIds: sortedEntryIds,
  });
}
