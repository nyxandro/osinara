/**
 * Authorized bounded memory-thread source loading.
 *
 * Exports:
 * - `ThreadSourceRow`: durable source projection before model-safe evidence mapping.
 * - `loadMemoryThreadSources`: loads prioritized evidenced records for deterministic context.
 */
import type { PoolClient } from "pg";

import {
  THREAD_BRIEF_MAX_ITEMS,
  THREAD_SOURCE_INPUT_MAX_CHARACTERS,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type { MemoryThreadBriefSource } from "./memory-thread-brief-generator.js";
import { loadMemoryThreadSourceEvidence } from "./memory-thread-source-evidence.js";

export interface ThreadSourceRow {
  content: string;
  entry_ref: string;
  occurred_at: Date;
  role: MemoryThreadBriefSource["role"];
  source_ref: string;
}

export async function loadMemoryThreadSources(
  client: Pick<PoolClient, "query">,
  threadId: string,
  auth: MemoryAuthorization,
): Promise<MemoryThreadBriefSource[]> {
  const result = await client.query<ThreadSourceRow>(
    `SELECT entry.entry_ref, entry.role::text, entry.occurred_at,
            COALESCE(claim.content, outcome.summary) AS content,
            COALESCE(memory_ref.memory_ref, outcome.outcome_ref) AS source_ref
     FROM memory_thread_entries AS entry
     JOIN memory_threads AS thread ON thread.id = entry.thread_id
     LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
       AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
       AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
     LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
     LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id
       AND outcome.status = 'confirmed'
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND entry.thread_id = $5 AND (claim.id IS NOT NULL OR outcome.id IS NOT NULL)
     ORDER BY CASE entry.role
       WHEN 'constraint' THEN 1 WHEN 'goal' THEN 2 WHEN 'open_loop' THEN 2
       WHEN 'method' THEN 3 WHEN 'decision' THEN 4 WHEN 'outcome' THEN 4
       WHEN 'lesson' THEN 5 ELSE 6 END,
       entry.occurred_at DESC, entry.id DESC
     LIMIT $6`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId, THREAD_BRIEF_MAX_ITEMS],
  );

  // Source selection keeps whole records in priority order and never truncates authoritative text.
  const bounded: ThreadSourceRow[] = [];
  let inputCharacters = 0;
  for (const row of result.rows) {
    if (inputCharacters + row.content.length > THREAD_SOURCE_INPUT_MAX_CHARACTERS) break;
    bounded.push(row);
    inputCharacters += row.content.length;
  }

  const evidence = new Map((await loadMemoryThreadSourceEvidence(client, threadId, auth))
    .map((item) => [item.sourceEntryRef, item]));
  return bounded.flatMap((row): MemoryThreadBriefSource[] => {
    const sourceEvidence = evidence.get(row.entry_ref);
    // Authorization may be revoked between source and evidence reads; omit content fail-closed.
    if (!sourceEvidence) return [];
    const { sourceEntryRef: _sourceEntryRef, ...modelEvidence } = sourceEvidence;
    return [{
      content: row.content,
      evidence: modelEvidence,
      occurredAt: row.occurred_at.toISOString(),
      ref: row.entry_ref,
      role: row.role,
      sourceRef: row.source_ref,
    }];
  });
}
