/**
 * Exact normalized source-backed duplicate reinforcement.
 *
 * Exports:
 * - `reinforceExactClaim`: serializes same-subject lookup and atomically records reinforcement.
 *   Identity is the normalized text plus subject, kind, slot and event date: two trips to the
 *   same city on different dates are two episodes, not one reinforced record.
 */
import type { PoolClient } from "pg";

import {
  insertClaimReinforcement,
  type PreparedClaimEvidence,
} from "./claim-evidence-writer.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { ReferencedMemoryRow } from "./memory-record.js";

interface ExactClaimIdentity {
  /** Slot of a semantic claim; a repeat in another slot is a different fact. */
  attribute: string | null;
  contentNormalized: string;
  /** Kind of the claim: a fact and an episode with the same words are different records. */
  kind: string;
  /** Event date of an episode: the same words on another date are another event. */
  occurredAt: string | null;
  memoryProjectId: string | null;
  operationKey: string;
  prepared: PreparedClaimEvidence | null;
  scope: "family" | "group" | "personal";
  scopePartitionKey: string;
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
  systemActor: boolean;
}

export async function reinforceExactClaim(
  client: PoolClient,
  auth: MemoryAuthorization,
  identity: ExactClaimIdentity,
): Promise<ReferencedMemoryRow | null> {
  const prepared = identity.prepared;

  // This lock closes the race between exact lookup and new-claim insertion without a global lock.
  const duplicateLock = JSON.stringify({
    content: identity.contentNormalized,
    memoryProjectId: identity.memoryProjectId,
    partition: identity.scopePartitionKey,
    scope: identity.scope,
    subjectLabel: identity.subjectLabel,
    subjectParticipantId: identity.subjectParticipantId,
    subjectUserId: identity.subjectUserId,
  });
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [duplicateLock]);
  const duplicate = await client.query<ReferencedMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope,
            item.kind, item.content, item.source, item.confirmation, item.sensitivity,
            item.message_thread_id, item.embedding_status, item.created_at, item.updated_at, item.occurred_at,
            ref.memory_ref
     FROM memory_items AS item
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.family_id = $1 AND item.scope = $2
       AND item.scope_partition_key = $3 AND item.claim_status = 'active'
       AND item.content_normalized = $4
        AND item.subject_participant_id IS NOT DISTINCT FROM $5::uuid
        AND item.subject_user_id IS NOT DISTINCT FROM $6::uuid
        AND item.subject_family_id IS NULL
        AND item.subject_label IS NOT DISTINCT FROM $7::text
        AND item.memory_project_id IS NOT DISTINCT FROM $8::uuid
        AND item.kind = $9::memory_kind
        AND item.attribute IS NOT DISTINCT FROM $10::text
        AND item.occurred_at IS NOT DISTINCT FROM $11::timestamptz
     ORDER BY item.created_at, item.id LIMIT 1 FOR UPDATE OF item`,
    [auth.familyId, identity.scope, identity.scopePartitionKey, identity.contentNormalized,
      identity.subjectParticipantId, identity.subjectUserId, identity.subjectLabel,
      identity.memoryProjectId, identity.kind, identity.attribute, identity.occurredAt],
  );
  const existing = duplicate.rows[0];
  if (!existing) return null;

  if (prepared) await insertClaimReinforcement(client, existing.id, prepared);
  await client.query(
    `UPDATE memory_items SET reinforcement_count = reinforcement_count + 1,
            last_reinforced_at = now(), updated_at = now() WHERE id = $1`,
    [existing.id],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'memory.reinforced', $3, jsonb_build_object('scope', $4::text))`,
    [auth.familyId, identity.systemActor ? null : prepared?.auditActorUserId ?? auth.userId,
      existing.id, identity.scope],
  );
  return existing;
}
