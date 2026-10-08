/**
 * Shared contracts for the group retrieval evaluation corpus.
 *
 * Exports:
 * - `MemoryRetrievalEvalGroupArea`: where a record lives — the measured chat or a bait area.
 * - `MemoryRetrievalEvalGroupRecord`: one synthetic record with its area.
 * - `MemoryRetrievalEvalGroupCategory` / `MemoryRetrievalEvalGroupQuery`: a question asked in the
 *   measured chat with the records it is expected to surface.
 */
import type { EvalRecordText } from "../memory-retrieval-eval-support.js";

/**
 * `agents_chat` is the external group the questions are asked in. The rest are bait: another
 * external group of the same family, and the owner's personal and family memory, each holding
 * records that would answer a question of the measured chat if isolation failed.
 */
export type MemoryRetrievalEvalGroupArea = "agents_chat" | "board_club" | "owner_family" | "owner_personal";

export interface MemoryRetrievalEvalGroupRecord extends EvalRecordText {
  area: MemoryRetrievalEvalGroupArea;
  updatedAt: string;
}

export type MemoryRetrievalEvalGroupCategory =
  /** Та же вещь другим словом: «гитхаб», «железо», «гардрейлы», «нжинкс». */
  | "alias_wording"
  /** Вопрос к боту о нём самом: внешность, голос, кто сделал, что ему можно. */
  | "bot_persona"
  /** Просьба кинуть ссылку, которую кто-то уже приносил в чат. */
  | "link_request"
  /** Факт о конкретном участнике: ответ — его запись, а не запись соседа на ту же тему. */
  | "participant_fact"
  /** Про этого участника такого нет, но про другого на ту же тему есть: выдача обязана быть пустой. */
  | "participant_near_miss"
  /** Реакция, подколка, болтовня в общем потоке: памяти не нужно ничего. */
  | "small_talk"
  /** Вопрос по теме, на который отвечают записи нескольких участников. */
  | "topic_any";

export interface MemoryRetrievalEvalGroupQuery {
  /** The handle of the person a near-miss question is about: anyone else's record is a neighbour's. */
  askedAbout?: string;
  category: MemoryRetrievalEvalGroupCategory;
  expectedKeys: readonly string[];
  key: string;
  text: string;
}
