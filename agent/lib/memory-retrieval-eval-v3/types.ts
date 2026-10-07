/**
 * Shared contracts for the v3 retrieval evaluation corpus.
 *
 * Exports:
 * - `MemoryRetrievalEvalCategoryV3`: query shapes, including the live ones v1 and v2 never had and
 *   the ones the real-memory golden set found failing.
 * - `MemoryRetrievalEvalRecordV3`: one synthetic record with its memory area, kind, and history.
 * - `MemoryRetrievalEvalQueryV3`: one query with the records it is expected to surface.
 *
 * `updatedAt` is a plain date: it only orders records of equal relevance inside a search branch,
 * and four files of full ISO timestamps would be that much harder to read and edit.
 */
import type { MemoryKind } from "../memory-record.js";

export type MemoryRetrievalEvalCategoryV3 =
  /** Та же вещь другим словом: сленг, сокращение, транслитерация («бэкап», «репа», «ДР»). */
  | "alias_wording"
  /** Обращение к боту в начале запроса — самая частая живая форма. */
  | "bot_address"
  /** Вопрос о дне или периоде, а дата есть только у события, не в его тексте. */
  | "date_question"
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
  /** Приветствие, реакция, проверка связи: памяти не нужно ничего, выдача обязана быть пустой. */
  | "small_talk"
  /** Опечатки, в том числе в именах собственных. */
  | "typo"
  /** Факт обновлялся: отвечает текущая версия, прежняя не всплывает никогда. */
  | "updated_fact"
  /** Расшифровка голоса: сплошной текст без знаков препинания и заглавных. */
  | "voice_transcript"
  /** «е» в запросе против «ё» в записи и наоборот. */
  | "yo_spelling";

export type MemoryRetrievalEvalScopeV3 = "family" | "personal";

export interface MemoryRetrievalEvalRecordV3 {
  content: string;
  key: string;
  kind: MemoryKind;
  /**
   * When the event happened, for a record whose text does not say it: a calendar date, or a
   * number of days before the run for questions such as «что было вчера». Days are UTC calendar
   * days; a search that reads the event date will need the reader's time zone pinned here too.
   */
  occurredOn?: string | { daysAgo: number };
  scope: MemoryRetrievalEvalScopeV3;
  /** What the record is about, as it would be stored on the record itself. */
  subjectLabel?: string;
  /** Key of the version that replaced this one: stored as superseded, never a valid answer. */
  supersededBy?: string;
  updatedAt: string;
}

export interface MemoryRetrievalEvalQueryV3 {
  category: MemoryRetrievalEvalCategoryV3;
  expectedKeys: readonly string[];
  key: string;
  text: string;
}
