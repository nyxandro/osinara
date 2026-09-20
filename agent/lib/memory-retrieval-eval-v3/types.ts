/**
 * Shared contracts for the v3 retrieval evaluation corpus.
 *
 * Exports:
 * - `MemoryRetrievalEvalCategoryV3`: query shapes, including the live ones v1 and v2 never had.
 * - `MemoryRetrievalEvalRecordV3`: one synthetic record with its memory area and kind.
 * - `MemoryRetrievalEvalQueryV3`: one query with the records it is expected to surface.
 *
 * `updatedAt` is a plain date: the corpus only needs a stable relative order for the recency term,
 * and four files of full ISO timestamps would be that much harder to read and edit.
 */
import type { MemoryKind } from "../memory-record.js";

export type MemoryRetrievalEvalCategoryV3 =
  /** Обращение к боту в начале запроса — самая частая живая форма. */
  | "bot_address"
  /** Эмодзи и разметка Markdown внутри вопроса. */
  | "emoji_markup"
  /** Точное попадание: числа, тикеры, коды, имена собственные. */
  | "exact"
  /** Запрос длиннее 400 символов — попадает под разрезание на куски. */
  | "long_query"
  /** Смешанный русско-английский текст. */
  | "mixed_language"
  /** Несколько независимых тем в одном сообщении. */
  | "multi_topic"
  /** Ответа в корпусе нет, и вопрос вообще не про память: выдача обязана быть пустой. */
  | "negative"
  /** Ответа нет, но рядом лежит очень похожая запись про другой объект или другого человека. */
  | "near_miss_negative"
  /** Словоформы русского языка. */
  | "russian_morphology"
  /** Пересказ своими словами без общих слов с записью. */
  | "semantic_paraphrase"
  /** Опечатки, в том числе в именах собственных. */
  | "typo"
  /** Расшифровка голоса: сплошной текст без знаков препинания и заглавных. */
  | "voice_transcript"
  /** «е» в запросе против «ё» в записи и наоборот. */
  | "yo_spelling";

export type MemoryRetrievalEvalScopeV3 = "family" | "personal";

export interface MemoryRetrievalEvalRecordV3 {
  content: string;
  key: string;
  kind: MemoryKind;
  scope: MemoryRetrievalEvalScopeV3;
  updatedAt: string;
}

export interface MemoryRetrievalEvalQueryV3 {
  category: MemoryRetrievalEvalCategoryV3;
  expectedKeys: readonly string[];
  key: string;
  text: string;
}
