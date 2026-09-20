/**
 * Production-derived identity hard negatives for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V2`: immutable identity-confusion fixture version.
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_V2`: fictional project, framework, link, and skill distractors.
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V2`: identity controls and abstention-required near misses.
 * - `MEMORY_RETRIEVAL_R1_BASELINE_V2`: measured current behavior before semantic gating.
 * - `MEMORY_RETRIEVAL_V2_FUTURE_GATES`: acceptance targets reserved for semantic-gating work.
 */
import type {
  MemoryRetrievalEvalQuery,
  MemoryRetrievalEvalRecord,
} from "./memory-retrieval-eval-fixture.v1.js";

export const MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V2 = "memory-retrieval-v2-identity";

// Names mirror the observed confusion classes, while URLs and statements remain synthetic.
export const MEMORY_RETRIEVAL_EVAL_RECORDS_V2: readonly MemoryRetrievalEvalRecord[] = [
  {
    content: "Репозиторий проекта Orca: https://code.example/orca/runtime.",
    key: "orca-repository",
    subjectLabel: "Проект Orca",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    content: "Документация фреймворка Eve опубликована по адресу https://docs.example/eve.",
    key: "eve-documentation",
    subjectLabel: "Фреймворк Eve",
    updatedAt: "2026-08-02T10:00:00.000Z",
  },
  {
    content: "Навык Pinecone Reader установлен локально из проверенного пакета навыков.",
    key: "local-skill-package",
    subjectLabel: "Навык Pinecone Reader",
    updatedAt: "2026-08-03T10:00:00.000Z",
  },
  {
    content: "Ссылка на макет семейного календаря: https://design.example/family-calendar.",
    key: "calendar-design-link",
    subjectLabel: "Семейный календарь",
    updatedAt: "2026-08-04T10:00:00.000Z",
  },
] as const;

export const MEMORY_RETRIEVAL_EVAL_QUERIES_V2: readonly MemoryRetrievalEvalQuery[] = [
  {
    category: "exact",
    expectedKeys: ["orca-repository"],
    key: "identity-control-orca-repository",
    text: "Где репозиторий Orca?",
  },
  {
    category: "exact",
    expectedKeys: ["eve-documentation"],
    key: "identity-control-eve-documentation",
    text: "Где документация Eve?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-osinara-vs-orca",
    text: "Осинара, где твой репозиторий?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-iva-vs-eve",
    text: "Что известно про ассистента Иву?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-project-repository-vs-skill",
    text: "Где репозиторий навыка Осинары?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-source-link-vs-design-link",
    text: "Дай ссылку на исходный код Осинары.",
  },
] as const;

// Pinned PostgreSQL/E5 measurement makes the known false-positive gap explicit and reproducible.
// The quarter is what naming the subject inside the vector bought: «Что известно про ассистента
// Иву?» no longer answers with the documentation of a framework called Eve. The three that remain
// ask about a project the corpus holds nothing about, and the search still offers the nearest
// neighbour it does hold.
export const MEMORY_RETRIEVAL_R1_BASELINE_V2 = {
  hardNegativeEmptyRate: 0.25,
  hardNegativeQueries: 4,
  identityControlRecallAt5: 1,
} as const;

// These targets become release gates only with the separately approved semantic-gating change.
export const MEMORY_RETRIEVAL_V2_FUTURE_GATES = {
  hardNegativeEmptyRateMinimum: 1,
  identityControlRecallAt5Minimum: 1,
} as const;
