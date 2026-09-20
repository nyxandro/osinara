/**
 * The header that tells the embedding model what a record is about.
 *
 * Exports:
 * - `MemoryEmbeddingSubject`: the parts of a record that identify its subject and kind.
 * - `memoryEmbeddingInput`: the text actually sent to the model for one chunk.
 *
 * The vector used to be built from the record's bare text. A 384-dimension multilingual model
 * separates rare proper nouns weakly, so «репозиторий проекта Осинара» and «репозиторий проекта
 * Orca» sat almost on top of each other, and a question about one returned the other — with the
 * confidence of a fact, which is worse than an empty answer because nothing shows the swap.
 *
 * Naming the subject inside the vector is what separates them. The kind comes along because it is
 * free and it distinguishes «Пётр пьёт зелёный чай» as a standing preference from an episode that
 * merely mentions tea.
 *
 * The memory area — personal, family, group — is deliberately left out. It would be the same word
 * on most of one family's records, and a term that appears everywhere pulls every vector the same
 * way instead of telling them apart.
 */
import type { MemoryKind } from "./memory-record.js";

export interface MemoryEmbeddingSubject {
  kind: MemoryKind;
  subjectLabel: string | null;
}

/** Enough of a label to name a person or a project; a sentence in this field is a mistake. */
const SUBJECT_LABEL_MAX_CHARACTERS = 80;

const KIND_TITLES: Record<MemoryKind, string> = {
  episode: "случай",
  family_shared: "общее для семьи",
  fact: "факт",
  preference: "предпочтение",
  profile: "профиль",
};

export function memoryEmbeddingInput(chunk: string, subject: MemoryEmbeddingSubject): string {
  const label = subject.subjectLabel?.trim().slice(0, SUBJECT_LABEL_MAX_CHARACTERS);
  const head = label ? `${label}. Вид: ${KIND_TITLES[subject.kind]}.` : `Вид: ${KIND_TITLES[subject.kind]}.`;
  return `${head} ${chunk}`;
}
