/**
 * Preferring the person a question names over people it does not.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR`: how much a record about another person is lowered.
 * - `namedPeople`: the handles of the people a question names, among the subjects it found.
 * - `preferNamedPeople`: the same ranked records with other people's records lowered.
 *
 * «Что Нина говорила про Стаю?»: Nina never mentioned it, Timur did, and his record took a place
 * beside hers — the model could hand Timur's opinion to Nina (#343). Dropping other people's
 * records was measured and rejected: in production a subject label is free text — «Осинара /
 * Мия», «Ilya Kruglov — система памяти», «Групповой чат» — the bot's own name is in most group
 * questions, and on 153 live turns the filter cost eight useful records and one turn's hit.
 *
 * So only a person counts, recognised by the shape the indexing writes for one — «Имя Фамилия
 * (handle)» with a Telegram handle — and another person's record is lowered, not removed: when the
 * named person has nothing on the topic, the neighbour is still there, below.
 */
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

// On the golden set 0.5 and 0.25 put the same records in the twelve places; on the group corpus
// only 0.25 moved every neighbour out of the first three, where 0.5 left two of five on top.
export const MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR = 0.25;

// «Нина Соколова (nina_s)», «Пух (@nyxandro)». A label with a dash, a slash or a comma is a topic
// or a group of subjects, not one person.
const PERSON_LABEL = /^\s*([^(—/,]+?)\s*\(@?([A-Za-z0-9_]{3,})\)\s*$/u;

interface Person {
  handle: string;
  names: string[];
}

function words(text: string): string[] {
  return text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function person(label: string | null): Person | null {
  const match = label === null ? null : PERSON_LABEL.exec(label);
  if (match === null) return null;
  return { handle: match[2]!.toLowerCase(), names: words(match[1]!).filter((name) => name.length >= 3) };
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

export function namedPeople(query: string, subjectLabels: readonly (string | null)[]): Set<string> {
  const tokens = words(query);
  const named = new Set<string>();
  for (const label of subjectLabels) {
    const candidate = person(label);
    if (candidate === null) continue;
    if (tokens.includes(candidate.handle) ||
      candidate.names.some((name) => tokens.some((token) => namesPerson(token, name)))) {
      named.add(candidate.handle);
    }
  }
  return named;
}

/** Ranked records, in rank order; returned re-ranked when the question names a person. */
export function preferNamedPeople(
  query: string,
  ranked: readonly ScoredMemoryRetrievalResult[],
): ScoredMemoryRetrievalResult[] {
  const named = namedPeople(query, ranked.map((result) => result.subjectLabel));
  if (named.size === 0) return [...ranked];
  return ranked
    .map((result, index) => {
      const subject = person(result.subjectLabel);
      const other = subject !== null && !named.has(subject.handle);
      return { index, result: other ? { ...result, score: result.score * MEMORY_RETRIEVAL_OTHER_PERSON_FACTOR } : result };
    })
    // Equal scores keep the statement's own order, which already broke its ties.
    .sort((left, right) => right.result.score - left.result.score || left.index - right.index)
    .map((entry) => entry.result);
}
