/**
 * The slot that says which property of a subject a record is about.
 *
 * Exports:
 * - `MEMORY_ATTRIBUTE_MAX_CHARACTERS`: how long a slot name may be.
 * - `normalizeMemoryAttribute`: the stored form of a slot name, or a refusal.
 * - `supersedeMemoryAttributeSlot`: retires the previous holder of this slot.
 * - `releaseMemoryAttributeSlot`: puts the chain back together when a version is removed.
 *
 * «Пью кофе без сахара» used to lie down beside «пьёт кофе с двумя ложками» as an equal, because
 * nothing in a record said *what it is about*. Both stayed active, both queued for the same twelve
 * slots, and which one came up depended on word overlap with the question rather than on which is
 * current. The person reads that as an assistant that did not remember.
 *
 * The slot is a short name of the property, never its value, and the model assigns it the way it
 * already assigns the kind and the subject. Two guards stand against the dangerous case — a slot
 * named so widely («еда») that it retires independent facts:
 *
 * - the name is bounded to a name, not a sentence, and is refused otherwise;
 * - retiring is reversible and visible: the previous version keeps its text, stays in the list and
 *   the export, points at its replacement, and comes back if the write is undone.
 *
 * Nothing here is inferred. Two records share a slot only when the model wrote the same name for
 * the same verified subject inside the same area of memory and the same project; a label subject
 * and a verified person are different subjects even when the label spells the person's name.
 *
 * A record with no subject at all is a deliberate exception rather than an oversight: a family fact
 * about «адрес дачи» belongs to the family, not to a person, so its slot covers the whole area of
 * memory. That is stated in the tool contract, because it is the one case where a slot name reaches
 * further than the model might expect.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryKind } from "./memory-record.js";

export const MEMORY_ATTRIBUTE_MAX_CHARACTERS = 40;

/** Supersession by slot, told apart from supersession by correction, which undo must not touch. */
const SLOT_RELATION = "temporal_update";

function attributeRefusal(message: string): AppError {
  return new AppError("AGENT_MEMORY_ATTRIBUTE_INVALID", message);
}

export function normalizeMemoryAttribute(value: string, kind: MemoryKind): string {
  if (kind === "episode") {
    throw attributeRefusal(
      "Событие не имеет свойства, которое меняется со временем: сохраните его без имени свойства",
    );
  }
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > MEMORY_ATTRIBUTE_MAX_CHARACTERS) {
    throw attributeRefusal(
      `Имя свойства должно быть коротким названием от 1 до ${MEMORY_ATTRIBUTE_MAX_CHARACTERS} символов, например «кофе» или «место работы»`,
    );
  }
  return normalized;
}

/**
 * The lock closes the window between finding the previous holder and retiring it: an interactive
 * turn and the silent review write at the same time, and on READ COMMITTED neither sees the other,
 * so both versions would stay active. It is the same device the exact-repeat path uses, keyed by
 * the same identity this function compares by.
 */
export async function lockMemoryAttributeSlot(
  client: PoolClient,
  identity: {
    attribute: string;
    memoryProjectId: string | null;
    scope: string;
    scopePartitionKey: string;
    subjectLabel: string | null;
    subjectParticipantId: string | null;
    subjectUserId: string | null;
  },
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify({ slot: identity })],
  );
}

/**
 * Two records hold the same slot when every part of their identity matches: the family, the area
 * of memory and its partition, the project, the subject in all of its forms, and the slot name.
 * The comparison reads the stored row rather than repeating its values as parameters, so a column
 * added to the subject cannot be forgotten on one side of the match.
 */
export async function supersedeMemoryAttributeSlot(
  client: PoolClient,
  claimId: string,
): Promise<string[]> {
  const retired = await client.query<{ id: string }>(
    `UPDATE memory_items_all AS previous
     SET claim_status = 'superseded', superseded_by = fresh.id, updated_at = now()
     FROM memory_items_all AS fresh
     WHERE fresh.id = $1 AND fresh.attribute IS NOT NULL
       AND previous.id <> fresh.id
       AND previous.claim_status = 'active' AND previous.deleted_at IS NULL
       AND previous.family_id = fresh.family_id
       AND previous.scope = fresh.scope
       AND previous.scope_partition_key = fresh.scope_partition_key
       AND previous.attribute = fresh.attribute
       AND previous.memory_project_id IS NOT DISTINCT FROM fresh.memory_project_id
       AND previous.subject_user_id IS NOT DISTINCT FROM fresh.subject_user_id
       AND previous.subject_participant_id IS NOT DISTINCT FROM fresh.subject_participant_id
       AND previous.subject_conversation_id IS NOT DISTINCT FROM fresh.subject_conversation_id
       AND previous.subject_family_id IS NOT DISTINCT FROM fresh.subject_family_id
       AND previous.subject_label IS NOT DISTINCT FROM fresh.subject_label
     RETURNING previous.id`,
    [claimId],
  );
  if (retired.rowCount === 0) return [];
  // The relation is the readable half of the same fact, and it is also what tells slot supersession
  // apart from a correction later on: a version changed over time, decided by the model's slot name
  // applied by a deterministic rule, not guessed by the code.
  await client.query(
    `INSERT INTO claim_relations
       (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
        relation_type, detection_method, detection_metadata)
     SELECT previous.id, $1, previous.family_id, previous.scope, previous.scope_partition_key,
            '${SLOT_RELATION}', 'model_guarded',
            jsonb_build_object('attribute', previous.attribute)
     FROM memory_items_all AS previous
     WHERE previous.id = ANY($2::uuid[])
     ON CONFLICT (source_claim_id, target_claim_id, relation_type) DO NOTHING`,
    [claimId, retired.rows.map((row) => row.id)],
  );
  return retired.rows.map((row) => row.id);
}

/**
 * Removing a version has to leave the chain of versions whole. Two cases, and only two:
 *
 * - the removed record is the current one, so the version it retired becomes current again —
 *   otherwise cancelling a mistaken write would cost the person the fact it replaced;
 * - the removed record was itself already replaced, so what it retired is handed on to its own
 *   replacement, which stays the only current version.
 *
 * Only supersession by slot is undone. A correction retires the text it corrected, and bringing
 * that back would answer the person with the very wording they asked to fix.
 */
export async function releaseMemoryAttributeSlot(
  client: PoolClient,
  claimId: string,
): Promise<void> {
  const successor = await client.query<{ superseded_by: string | null }>(
    "SELECT superseded_by FROM memory_items_all WHERE id = $1",
    [claimId],
  );
  const heir = successor.rows[0]?.superseded_by ?? null;
  const released = await client.query<{ id: string }>(
    `UPDATE memory_items_all AS previous
     SET claim_status = (CASE WHEN $2::uuid IS NULL THEN 'active' ELSE 'superseded' END)
                        ::memory_claim_status,
         superseded_by = $2::uuid, updated_at = now()
     FROM claim_relations AS relation
     WHERE relation.source_claim_id = previous.id AND relation.target_claim_id = $1
       AND relation.relation_type = '${SLOT_RELATION}'
       AND previous.superseded_by = $1 AND previous.claim_status = 'superseded'
       AND previous.deleted_at IS NULL
     RETURNING previous.id`,
    [claimId, heir],
  );
  if (heir !== null && released.rowCount) {
    await client.query(
      `INSERT INTO claim_relations
         (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
          relation_type, detection_method, detection_metadata)
       SELECT previous.id, $1, previous.family_id, previous.scope, previous.scope_partition_key,
              '${SLOT_RELATION}', 'model_guarded',
              jsonb_build_object('attribute', previous.attribute)
       FROM memory_items_all AS previous
       WHERE previous.id = ANY($2::uuid[])
       ON CONFLICT (source_claim_id, target_claim_id, relation_type) DO NOTHING`,
      [heir, released.rows.map((row) => row.id)],
    );
  }
  await client.query(
    `DELETE FROM claim_relations
     WHERE target_claim_id = $1 AND relation_type = '${SLOT_RELATION}'`,
    [claimId],
  );
}
