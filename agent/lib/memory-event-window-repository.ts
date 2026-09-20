/**
 * Finding what belongs to a period rather than what mentions its name.
 *
 * Exports:
 * - `MEMORY_EVENT_WINDOW_LIMIT`: how many records one period may return.
 * - `normalizeMemoryEventDate`: the stored form of an event date, or a refusal.
 * - `memoryEventWindowRepository.search`: the records of one period, newest event first.
 *
 * «Что мы решали в августе?» used to be answered by word overlap: the search found records with
 * the word «август» in them, not records that belong to August. The only time a record carried was
 * when it was saved, and that answers a different question — 58% of production memory was written
 * on three active days, so as an axis of time it is unusable.
 *
 * A record with no event date is not dropped from a period: it falls back to the day it was
 * written, which is the best evidence there is. The 196 episodes stored before this existed have
 * no event date and never will, and that is accepted rather than filled in afterwards.
 *
 * Ageing is deliberately left alone. A trip from ten years ago, told today, is fresh knowledge,
 * and the forgetting curve keeps reading `created_at`; mixing the two axes would hide what a
 * person has only just said.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { ReferencedMemoryItem, ReferencedMemoryRow } from "./memory-record.js";
import { rowToReferencedMemory } from "./memory-record.js";

export const MEMORY_EVENT_WINDOW_LIMIT = 20;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const EARLIEST_EVENT_DATE = "1900-01-01";
const LATEST_EVENT_DATE = "2100-01-01";

/**
 * The bounds catch nonsense, not a wrong day: a year of 20260, or an event under Ivan the Terrible.
 * A date the model is unsure about must be left out altogether, and that rule lives in the
 * instruction rather than here, because no check can tell a guess from a fact.
 */
export function normalizeMemoryEventDate(value: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed)) ||
    trimmed < EARLIEST_EVENT_DATE || trimmed > LATEST_EVENT_DATE) {
    throw new AppError(
      "AGENT_MEMORY_OCCURRED_ON_INVALID",
      `Дата события должна быть днём в формате ГГГГ-ММ-ДД между ${EARLIEST_EVENT_DATE} и ${LATEST_EVENT_DATE}; если день неизвестен, не указывай его`,
    );
  }
  return trimmed;
}

export const memoryEventWindowRepository = {
  async search(
    auth: MemoryAuthorization,
    window: { from: string; to: string },
  ): Promise<ReferencedMemoryItem[]> {
    const from = normalizeMemoryEventDate(window.from);
    const to = normalizeMemoryEventDate(window.to);
    if (from > to) {
      throw new AppError(
        "AGENT_MEMORY_EVENT_WINDOW_INVALID",
        "Начало периода не может быть позже его конца",
      );
    }
    const result = await database().query<ReferencedMemoryRow>(
      `SELECT item.id, item.attribute, item.occurred_on, item.author_user_id,
              item.author_telegram_user_id, item.scope, item.kind, item.content, item.source,
              item.confirmation, item.sensitivity, item.message_thread_id, item.embedding_status,
              item.created_at, item.updated_at, ref.memory_ref
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       WHERE item.family_id = $1 AND item.claim_status = 'active'
         AND ${liveMemoryReadPredicate({ alias: "item", personalIdentityColumn: "owner_user_id" })}
         -- The event date when the conversation gave one, otherwise the day it was written down.
         AND COALESCE(item.occurred_on, item.created_at::date) BETWEEN $5::date AND $6::date
       ORDER BY COALESCE(item.occurred_on, item.created_at::date) DESC, ref.memory_ref DESC
       LIMIT $7`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, from, to, MEMORY_EVENT_WINDOW_LIMIT],
    );
    return result.rows.map(rowToReferencedMemory);
  },
};
