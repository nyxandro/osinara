/**
 * Preferring the person a question names over people it does not.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR`: how much a record about another person is lowered.
 * - `namedPeople`: the people a question names, among the subjects it found, by their keys.
 * - `preferNamedPeople`: the same ranked records with other people's records lowered.
 *
 * «Что Нина говорила про Стаю?»: Nina never mentioned it, Timur did, and his record took a place
 * beside hers — the model could hand Timur's opinion to Nina (#343). Dropping other people's
 * records was measured and rejected: in production a subject label is free text — «Осинара /
 * Мия», «Ilya Kruglov — система памяти», «Групповой чат» — the bot's own name is in most group
 * questions, and on 153 live turns the filter cost eight useful records and one turn's hit.
 *
 * So only a person counts, and another person's record is lowered, not removed: when the named
 * person has nothing on the topic, the neighbour is still there, below. A record bound to a person
 * is recognised by the binding (#556): the server knows the person's current name and username, and
 * most bound records carry no label at all. A record without a binding is recognised by the shape the
 * indexing writes for one — «Имя Фамилия (handle)» with a Telegram handle.
 *
 * A person's key is their username, so a label and a binding naming one handle are one person; a
 * bound person without a username is keyed by the binding itself and recognised by name only.
 *
 * The asker's own records are never lowered. «Что я обещал Нине?» names Нина, and the asker's own
 * record — bound to them, since nearly every record is bound — is the answer; the asker says «я», not
 * their name. Before #556 these records counted as nobody and were never lowered either.
 */
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

// On the golden set 0.5 and 0.25 put the same records in the twelve places; on the group corpus
// only 0.25 moved every neighbour out of the first three, where 0.5 left two of five on top.
export const MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR = 0.25;

// «Нина Соколова (nina_s)», «Пух (@nyxandro)». A label with a dash, a slash or a comma is a topic
// or a group of subjects, not one person.
const PERSON_LABEL = /^\s*([^(—/,]+?)\s*\(@?([A-Za-z0-9_]{3,})\)\s*$/u;

export type RankedSubject = Pick<ScoredMemoryRetrievalResult, "subjectLabel" | "subjectPerson">;

interface Person {
  handle: string | null;
  key: string;
  names: string[];
}

function words(text: string): string[] {
  return text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function names(text: string): string[] {
  return words(text).filter((name) => name.length >= 3);
}

function person(subject: RankedSubject): Person | null {
  const bound = subject.subjectPerson;
  if (bound !== null) {
    const handle = bound.username === null ? "" : bound.username.trim().toLowerCase();
    const boundNames = bound.name === null ? [] : names(bound.name);
    if (!handle && boundNames.length === 0) return null;
    return { handle: handle || null, key: handle || bound.key, names: boundNames };
  }
  const match = subject.subjectLabel === null ? null : PERSON_LABEL.exec(subject.subjectLabel);
  if (match === null) return null;
  const handle = match[2]!.toLowerCase();
  return { handle, key: handle, names: names(match[1]!) };
}

/**
 * «Нина» in «Нины», «Нине», «Ниной»; «Тимур» in «Тимура», «Тимуром». The stem is the name without
 * its final vowel, and what follows it has to look like a case ending, so «Ник» does not claim
 * «никто» and «Роман» does not claim «романтика».
 */
function namesPerson(token: string, name: string): boolean {
  if (token === name) return true;
  const stem = name.replace(/[аеиоуыюяйь]$/u, "");
  if (stem.length < 3 || !token.startsWith(stem)) return false;
  const ending = token.slice(stem.length);
  return ending.length <= 3 && /^[аеиоуыюяйь]*(?:м|х|ми)?$/u.test(ending);
}

export function namedPeople(query: string, subjects: readonly RankedSubject[]): Set<string> {
  const tokens = words(query);
  const named = new Set<string>();
  for (const subject of subjects) {
    const candidate = person(subject);
    if (candidate === null) continue;
    if ((candidate.handle !== null && tokens.includes(candidate.handle)) ||
      candidate.names.some((name) => tokens.some((token) => namesPerson(token, name)))) {
      named.add(candidate.key);
    }
  }
  return named;
}

/** Ranked records, in rank order; returned re-ranked when the question names a person. */
export function preferNamedPeople(
  query: string,
  ranked: readonly ScoredMemoryRetrievalResult[],
  /** The Telegram user asking, whose own records stay where they are; null for a run with no asker. */
  askerTelegramUserId: string | null,
): ScoredMemoryRetrievalResult[] {
  const named = namedPeople(query, ranked);
  if (named.size === 0) return [...ranked];
  return ranked
    .map((result, index) => {
      const subject = person(result);
      const asker = askerTelegramUserId !== null && result.subjectPerson?.telegramUserId === askerTelegramUserId;
      const other = subject !== null && !named.has(subject.key) && !asker;
      return { index, result: other ? { ...result, score: result.score * MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR } : result };
    })
    // Equal scores keep the statement's own order, which already broke its ties.
    .sort((left, right) => right.result.score - left.result.score || left.index - right.index)
    .map((entry) => entry.result);
}
