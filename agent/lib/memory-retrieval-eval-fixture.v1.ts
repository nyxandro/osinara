/**
 * Versioned synthetic fixture for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION`: immutable fixture contract version.
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_V1`: fictional searchable records and duplicate pollution.
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V1`: multilingual positive, typo, and negative queries.
 * - `MEMORY_RETRIEVAL_R0_BASELINE_V1`: measured pre-R1 quality on this exact fixture.
 * - `MEMORY_RETRIEVAL_R1_SEMANTIC_CALIBRATION_V1`: pinned E5 relevance margin observations.
 * - `MEMORY_RETRIEVAL_R1_GATES_V1`: measurable acceptance thresholds for R1.
 */

export const MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION = "memory-retrieval-v1";

export type MemoryRetrievalEvalCategory =
  | "exact"
  | "mixed_language"
  | "negative"
  | "russian_morphology"
  | "semantic_paraphrase"
  | "typo";

export interface MemoryRetrievalEvalRecord {
  content: string;
  key: string;
  updatedAt: string;
}

export interface MemoryRetrievalEvalQuery {
  category: MemoryRetrievalEvalCategory;
  expectedKeys: readonly string[];
  key: string;
  text: string;
}

// The corpus is intentionally fictional and contains no copied or real personal information.
export const MEMORY_RETRIEVAL_EVAL_RECORDS_V1: readonly MemoryRetrievalEvalRecord[] = [
  {
    content: "Встреча с архитектором Ксенией Ветровой назначена на 14:35.",
    key: "architect-meeting",
    updatedAt: "2026-07-01T10:00:00.000Z",
  },
  {
    content: "По субботам семья покупает свежие помидоры на Янтарном рынке.",
    key: "tomato-market",
    updatedAt: "2026-07-02T10:00:00.000Z",
  },
  {
    content: "Код тестовой кладовой: 482917. Контакт для макета: Илья Норд.",
    key: "storage-code",
    updatedAt: "2026-07-03T10:00:00.000Z",
  },
  {
    content: "В учебном списке наблюдения указан тикер YDEX.",
    key: "ticker",
    updatedAt: "2026-07-04T10:00:00.000Z",
  },
  {
    content: "Для проекта Aurora production deploy выполняется по пятницам.",
    key: "mixed-deploy",
    updatedAt: "2026-07-05T10:00:00.000Z",
  },
  {
    content: "Запасной ключ от вымышленной мастерской лежит в синей коробке на верхней полке.",
    key: "spare-key",
    updatedAt: "2026-07-06T10:00:00.000Z",
  },
  {
    content: "Резервная копия учебного проекта хранится в каталоге Север-7.",
    key: "backup-location",
    updatedAt: "2026-07-07T10:00:00.000Z",
  },
  {
    content: "Термометр для макета хранится в нижнем ящике стола.",
    key: "thermometer",
    updatedAt: "2026-07-08T10:00:00.000Z",
  },
  {
    content: "Врач из учебного сценария рекомендует пить воду утром.",
    key: "duplicate-old",
    updatedAt: "2026-07-09T10:00:00.000Z",
  },
  {
    content: "  ВРАЧ из учебного сценария рекомендует пить воду утром!!!  ",
    key: "duplicate-new",
    updatedAt: "2026-07-10T10:00:00.000Z",
  },
  {
    content: "Макет оранжевого велосипеда находится рядом с декорацией маяка.",
    key: "distractor-bicycle",
    updatedAt: "2026-07-11T10:00:00.000Z",
  },
] as const;

export const MEMORY_RETRIEVAL_EVAL_QUERIES_V1: readonly MemoryRetrievalEvalQuery[] = [
  {
    category: "russian_morphology",
    expectedKeys: ["architect-meeting"],
    key: "inflected-name",
    text: "Ксения Ветрова",
  },
  {
    category: "russian_morphology",
    expectedKeys: ["tomato-market"],
    key: "inflected-common-words",
    text: "Где покупали помидор?",
  },
  {
    category: "exact",
    expectedKeys: ["storage-code"],
    key: "exact-name",
    text: "Илья Норд",
  },
  {
    category: "exact",
    expectedKeys: ["storage-code"],
    key: "exact-number",
    text: "482917",
  },
  {
    category: "exact",
    expectedKeys: ["ticker"],
    key: "exact-ticker",
    text: "YDEX",
  },
  {
    category: "mixed_language",
    expectedKeys: ["mixed-deploy"],
    key: "mixed-russian-english",
    text: "Когда production deploy проекта Aurora?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["spare-key"],
    key: "russian-paraphrase",
    text: "Как попасть в мастерскую, если основной комплект потерялся?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["backup-location"],
    key: "cross-language-paraphrase",
    text: "Where is the training project backup stored?",
  },
  {
    category: "typo",
    expectedKeys: ["thermometer"],
    key: "single-typo",
    text: "Где лежит термомтетр?",
  },
  {
    // Either half of the duplicate pair is a correct answer: they are the same sentence, and which
    // of the two represents the cluster is decided by rank. Pinning one of them would measure the
    // ranking of identical text; what this query is for is `duplicateResultsAt5`, which still
    // requires that only one of the pair takes a slot.
    category: "exact",
    expectedKeys: ["duplicate-old", "duplicate-new"],
    key: "duplicate-pollution",
    text: "Что врач рекомендует пить утром?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "irrelevant-weather",
    text: "Какая сегодня погода в Лиссабоне?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "irrelevant-chess",
    text: "Кто выиграл чемпионат по шахматам?",
  },
] as const;

// Measured by the red R0 run before retrieval behavior was changed.
export const MEMORY_RETRIEVAL_R0_BASELINE_V1 = {
  duplicateResultsAt5: 2,
  negativeEmptyRate: 0,
  positiveRecallAt5: 1,
  typoRecovered: true,
} as const;

// Pinned E5 score observations leave a visible margin around the configured 0.78 gate.
export const MEMORY_RETRIEVAL_R1_SEMANTIC_CALIBRATION_V1 = {
  irrelevantSimilarityMaximum: 0.73893,
  requiredParaphraseSimilarityMinimum: 0.79002,
} as const;

export const MEMORY_RETRIEVAL_R1_GATES_V1 = {
  duplicateResultsAt5Maximum: 1,
  negativeEmptyRateMinimum: 1,
  positiveRecallAt5Minimum: 0.9,
} as const;
