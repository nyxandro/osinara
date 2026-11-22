/**
 * Refusing a record whose text names another participant than the one it is bound to (#556).
 *
 * Exports:
 * - `MemorySubjectNameMismatchRefusal`: the refusal, with whom the record is bound to and whom it names.
 * - `requireSubjectNamedConsistently`: compares the text with the chat's participants and refuses.
 * - `memorySubjectNameMismatchRefusalResult`: what the model is told, so it saves the fact again.
 *
 * The comparison lives in `memory-subject-name-check.ts`; this module only gathers the usernames from
 * the chat. The refusal is a result, not a failure: the fact is not lost, the model saves it on the
 * right person in the same turn. A person without a username is never checked, because a name in
 * the text cannot be matched reliably — cases, nicknames — and a false refusal would cost the fact.
 */
import type { PoolClient } from "pg";

import { formatMemorySubjectPerson } from "./memory-subject-person.js";
import { subjectNameMismatch } from "./memory-subject-name-check.js";

export const MEMORY_SUBJECT_NAME_MISMATCH_CODE = "AGENT_MEMORY_SUBJECT_NAME_MISMATCH";

export class MemorySubjectNameMismatchRefusal extends Error {
  readonly code = MEMORY_SUBJECT_NAME_MISMATCH_CODE;

  constructor(
    /** The bound person as the model sees them in `about`. */
    readonly boundPerson: string,
    /** The other participants the text names, as «@username». */
    readonly named: readonly string[],
  ) {
    super(`${MEMORY_SUBJECT_NAME_MISMATCH_CODE}: Текст записи называет другого участника чата`);
    this.name = "MemorySubjectNameMismatchRefusal";
  }
}

export async function requireSubjectNamedConsistently(
  client: PoolClient,
  input: {
    content: string;
    conversationId: string;
    subjectParticipantId: string | null;
    subjectUserId: string | null;
  },
): Promise<void> {
  if (input.subjectParticipantId === null && input.subjectUserId === null) return;
  const bound = (await client.query<{ name: string | null; username: string | null }>(
    "SELECT name, username FROM memory_subject_person($1::uuid, $2::uuid)",
    [input.subjectParticipantId, input.subjectUserId],
  )).rows[0];
  if (bound === undefined || bound.username === null) return;
  // The bound person's own rows are not «another participant», whichever way they are bound.
  const others = await client.query<{ username: string }>(
    `SELECT DISTINCT participant.username_snapshot AS username
     FROM conversation_participants AS participant
     WHERE participant.conversation_id = $1 AND participant.username_snapshot IS NOT NULL
       AND participant.id IS DISTINCT FROM $2::uuid
       AND ($3::uuid IS NULL OR participant.linked_user_id IS DISTINCT FROM $3::uuid)`,
    [input.conversationId, input.subjectParticipantId, input.subjectUserId],
  );
  const named = subjectNameMismatch(input.content, bound.username, others.rows.map((row) => row.username));
  if (named === null) return;
  throw new MemorySubjectNameMismatchRefusal(
    formatMemorySubjectPerson(bound) ?? `@${bound.username}`,
    named.map((username) => `@${username}`),
  );
}

export function memorySubjectNameMismatchRefusalResult(
  refusal: MemorySubjectNameMismatchRefusal,
  options: { readonly verifiedRefAvailable: boolean },
) {
  const anotherPerson = options.verifiedRefAvailable
    ? "Если факт о другом человеке — сохрани его на этого человека: subject verified_ref, если он есть в карточках этого хода, иначе метка «Имя (@username)»."
    : "Если факт о другом человеке — сохрани его на этого человека с меткой «Имя (@username)».";
  return {
    code: refusal.code,
    correction: [
      `Запись не сохранена: она привязана к «${refusal.boundPerson}», а в тексте назван другой участник этого чата (${refusal.named.join(", ")}) и не назван сам «${refusal.boundPerson}».`,
      "Пересказ чужих слов — факт о том, о ком он, а не о том, кто рассказал.",
      anotherPerson,
      `Если это собственный факт «${refusal.boundPerson}» (его мнение, событие или свойство, где другой только упомянут) — назови его в тексте и повтори вызов.`,
    ].join(" "),
    reason: `Текст записи называет другого участника, а запись привязана к «${refusal.boundPerson}».`,
    saved: false,
  };
}
