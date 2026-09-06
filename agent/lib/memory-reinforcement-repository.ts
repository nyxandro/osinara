/**
 * Reinforcement of existing memory records by opaque ref.
 *
 * Export:
 * - `memoryReinforcementRepository.reinforceByRefs`: bumps `reinforcement_count` and
 *   `last_reinforced_at` for active records the caller may read, and audits each bump.
 *
 * Reinforcement is the only signal that widens a record's stability (see
 * `memory-retention-score.ts`); it must come from use, never from mere display.
 */
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";

export type MemoryReinforcementReason = "model_used" | "remember_reinforces";

export interface ReinforceByRefsInput {
  memoryRefs: readonly string[];
  provenance: { sessionId: string; turnId: string };
  reason: MemoryReinforcementReason;
}

export interface ReinforceByRefsResult {
  reinforced: string[];
  unknown: string[];
}

export const memoryReinforcementRepository = {
  async reinforceByRefs(auth: MemoryAuthorization, input: ReinforceByRefsInput): Promise<ReinforceByRefsResult> {
    const requested = [...new Set(input.memoryRefs)];
    if (requested.length === 0) return { reinforced: [], unknown: [] };
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // The same scope predicate as model-facing mutations: a ref outside the caller's areas is unknown.
      const rows = await client.query<{ id: string; memory_ref: string }>(
        `SELECT item.id, ref.memory_ref
           FROM memory_item_refs AS ref
           JOIN memory_items AS item ON item.id = ref.memory_item_id
          WHERE ref.memory_ref = ANY($1::text[])
            AND item.family_id = $2 AND item.claim_status = 'active' AND item.deleted_at IS NULL
            AND (
              (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[]) AND item.owner_user_id = $4) OR
              (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
              (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
            )
          ORDER BY item.created_at, item.id
          FOR UPDATE OF item`,
        [requested, auth.familyId, auth.scopes, auth.userId, auth.groupId],
      );
      for (const row of rows.rows) {
        await client.query(
          `UPDATE memory_items
              SET reinforcement_count = reinforcement_count + 1, last_reinforced_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'memory.reinforced', $3,
                   jsonb_build_object('reason', $4::text, 'sessionId', $5::text, 'turnId', $6::text))`,
          [auth.familyId, auth.userId, row.id, input.reason, input.provenance.sessionId, input.provenance.turnId],
        );
      }
      await client.query("COMMIT");
      const reinforced = rows.rows.map((row) => row.memory_ref);
      return { reinforced, unknown: requested.filter((ref) => !reinforced.includes(ref)) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
