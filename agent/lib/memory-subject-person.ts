/**
 * Whom a memory record is about, as the person is named now (#556).
 *
 * Exports:
 * - `MemorySubjectPerson`: the current Telegram name and username of the person a record is bound to.
 * - `formatMemorySubjectPerson`: «Имя (@username)», the one spelling every reader of it gets.
 * - `loadMemorySubjectPeople`: the people behind a set of records, in one query.
 * - `loadWrittenMemorySubjectPeople`: the same for records a committed write has just returned.
 *
 * A record about a person is bound to them by Telegram id, but the model used to see only the text,
 * where the person is whatever the model wrote at the time: a namesake, a username that has changed
 * since, or no name at all. The binding is what the server knows for certain, so the server says it
 * next to the text. `memory_subject_person` (migration 157) is the single place that decides whose
 * row names the person; this module only reads it.
 */
import { database } from "./database.js";
import { memoryFailureCode } from "./memory-context-failure.js";

export interface MemorySubjectPerson {
  name: string | null;
  username: string | null;
}

export function formatMemorySubjectPerson(person: MemorySubjectPerson): string | null {
  const name = person.name?.trim() ?? "";
  const username = person.username?.trim() ?? "";
  if (name && username) return `${name} (@${username})`;
  if (name) return name;
  return username ? `@${username}` : null;
}

/** Records bound to nobody are absent from the result: that is their answer, not a gap. */
export async function loadMemorySubjectPeople(
  memoryIds: readonly string[],
): Promise<ReadonlyMap<string, MemorySubjectPerson>> {
  if (memoryIds.length === 0) return new Map();
  const result = await database().query<{ id: string; name: string | null; username: string | null }>(
    `SELECT item.id, person.name, person.username
     FROM memory_items_all AS item
     CROSS JOIN LATERAL memory_subject_person(item.subject_participant_id, item.subject_user_id) AS person
     WHERE item.id = ANY($1::uuid[])`,
    [[...new Set(memoryIds)]],
  );
  return new Map(result.rows.map((row) => [row.id, { name: row.name, username: row.username }]));
}

/**
 * The write is committed before this read, so the record exists whatever the read does. A database
 * that blinks right then must not turn a saved record into a failed call — the model would save it
 * again — so the answer goes out without `about`, and the miss is written down.
 */
export async function loadWrittenMemorySubjectPeople(
  memoryIds: readonly string[],
): Promise<ReadonlyMap<string, MemorySubjectPerson>> {
  try {
    return await loadMemorySubjectPeople(memoryIds);
  } catch (error) {
    console.warn(JSON.stringify({
      code: "AGENT_MEMORY_SUBJECT_PERSON_UNAVAILABLE",
      causeCode: memoryFailureCode(error) ?? "UNCLASSIFIED_DATABASE_ERROR",
      records: memoryIds.length,
    }));
    return new Map();
  }
}
