/**
 * The slot that says which property of a subject a record is about.
 *
 * Exports:
 * - `MEMORY_ATTRIBUTE_MAX_CHARACTERS`: how long a slot name may be.
 * - `normalizeMemoryAttribute`: the stored form of a slot name, or a refusal.
 * - `supersedeMemoryAttributeSlot`: retires the previous holder of this slot.
 * - `restoreMemoryAttributeSlot`: puts back what a claim had retired.
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
 * Nothing here is inferred. Two records share a slot only if the model wrote the same name for the
 * same verified subject inside the same area of memory; a label subject and a verified person are
 * different subjects even when the label spells the person's name.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryKind } from "./memory-record.js";

export const MEMORY_ATTRIBUTE_MAX_CHARACTERS = 40;

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
 * Two records hold the same slot when every part of their identity matches: the family, the area
 * of memory and its partition, the subject in all four of its forms, and the slot name itself.
 * The comparison reads the stored row rather than repeating its values as parameters, so a column
 * added to the subject cannot be forgotten on one side of the match.
 */
export async function supersedeMemoryAttributeSlot(
  client: PoolClient,
  claimId: string,
): Promise<string[]> {
  const retired = await client.query<{ id: string }>(
    `UPDATE memory_items_all AS previous
     SET claim_status = 'superseded', superseded_by = fresh.id, duplicate_of = NULL,
         updated_at = now()
     FROM memory_items_all AS fresh
     WHERE fresh.id = $1 AND fresh.attribute IS NOT NULL
       AND previous.id <> fresh.id
       AND previous.claim_status = 'active' AND previous.deleted_at IS NULL
       AND previous.family_id = fresh.family_id
       AND previous.scope = fresh.scope
       AND previous.scope_partition_key = fresh.scope_partition_key
       AND previous.attribute = fresh.attribute
       AND previous.subject_user_id IS NOT DISTINCT FROM fresh.subject_user_id
       AND previous.subject_participant_id IS NOT DISTINCT FROM fresh.subject_participant_id
       AND previous.subject_conversation_id IS NOT DISTINCT FROM fresh.subject_conversation_id
       AND previous.subject_label IS NOT DISTINCT FROM fresh.subject_label
     RETURNING previous.id`,
    [claimId],
  );
  if (retired.rowCount === 0) return [];
  // The relation is the readable half of the same fact: a version changed over time, and the
  // decision was the model's slot name applied by a deterministic rule, not a guess by the code.
  await client.query(
    `INSERT INTO claim_relations
       (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
        relation_type, detection_method, detection_metadata)
     SELECT previous.id, $1, previous.family_id, previous.scope, previous.scope_partition_key,
            'temporal_update', 'model_guarded', jsonb_build_object('attribute', previous.attribute)
     FROM memory_items_all AS previous
     WHERE previous.id = ANY($2::uuid[])
     ON CONFLICT (source_claim_id, target_claim_id, relation_type) DO NOTHING`,
    [claimId, retired.rows.map((row) => row.id)],
  );
  return retired.rows.map((row) => row.id);
}

/**
 * Undoing a write has to undo all of it. Without this, cancelling a mistaken new version would
 * leave the previous one retired, and the person would lose a fact by correcting the assistant.
 */
export async function restoreMemoryAttributeSlot(
  client: PoolClient,
  claimId: string,
): Promise<void> {
  await client.query(
    `UPDATE memory_items_all
     SET claim_status = 'active', superseded_by = NULL, updated_at = now()
     WHERE superseded_by = $1 AND claim_status = 'superseded' AND deleted_at IS NULL`,
    [claimId],
  );
  await client.query(
    "DELETE FROM claim_relations WHERE target_claim_id = $1 AND relation_type = 'temporal_update'",
    [claimId],
  );
}
