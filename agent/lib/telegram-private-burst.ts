/**
 * Private-chat bursts: a person often sends several messages in a row.
 *
 * Exports:
 * - `requireTelegramPrivateBurstPolicy`: fail-fast validation of the quiet window and its cap.
 * - `telegramPrivateBurstRepository`: when the next held private chat becomes ready.
 * - `waitForHeldPrivateChat`: lets an idle drain sleep until a held chat is ready, instead of
 *   leaving the reply to the next five-second poll.
 * - `joinTelegramBurst`: inside the claim, binds the waiting followers of a private head to it and
 *   returns the whole burst.
 *
 * Key constructs:
 * - The head of a private chat is claimed only after the chat has been quiet for the window, so a
 *   burst is complete before its turn starts. A steady stream is claimed once the cap has passed.
 * - The followers bind to the head exactly like the photos of one album: no claim takes them, and
 *   they complete, fail and recover together with the head.
 * - The burst is fixed once the head was handed to Eve; a message arriving later starts the next one.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { TelegramIngressRepository, TelegramPrivateBurstPolicy } from "./telegram-ingress-contract.js";
import { selectTelegramBurstMembers } from "./telegram-private-burst-message.js";
// The claim reads the clock after the timer fires; this margin keeps it past the ready moment.
const HELD_CHAT_WAKE_MARGIN_MILLISECONDS = 50;

export function requireTelegramPrivateBurstPolicy(window: TelegramPrivateBurstPolicy): TelegramPrivateBurstPolicy {
  const { maxCharacters, maxMessages, maxWaitMilliseconds, quietMilliseconds } = window;
  if (![maxWaitMilliseconds, quietMilliseconds].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    ![maxCharacters, maxMessages].every((value) => Number.isSafeInteger(value) && value >= 1) ||
    maxWaitMilliseconds < quietMilliseconds) {
    throw new AppError(
      "AGENT_TELEGRAM_BURST_WINDOW_INVALID",
      "Пауза перед ответом или размер пачки сообщений в личном чате заданы неверно",
    );
  }
  return window;
}

export const telegramPrivateBurstRepository = {
  async readyInMilliseconds(window: TelegramPrivateBurstPolicy): Promise<number | null> {
    requireTelegramPrivateBurstPolicy(window);
    // The same moment the claim condition waits for: quiet since the newest message, or the cap
    // counted from the oldest one.
    const result = await database().query<{ wait: string | null }>(
      `SELECT ceil(extract(epoch FROM min(ready_at) - clock_timestamp()) * 1000)::bigint::text AS wait
         FROM (
           SELECT LEAST(max(received_at) + ($1 * interval '1 millisecond'),
                        min(received_at) + ($2 * interval '1 millisecond')) AS ready_at
             FROM telegram_ingress_updates
            WHERE status = 'pending' AND (payload #>> '{message,chat,type}') IS NOT DISTINCT FROM 'private'
            GROUP BY queue_id
         ) held
        WHERE ready_at > clock_timestamp()`,
      [window.quietMilliseconds, window.maxWaitMilliseconds],
    );
    const wait = result.rows[0]?.wait;
    return wait === null || wait === undefined ? null : Number(wait);
  },
};

/** True after sleeping until a held private chat is ready, so the caller claims again; false when none is held. */
export async function waitForHeldPrivateChat(
  repository: Pick<TelegramIngressRepository, "privateBurstReadyIn">,
  window: TelegramPrivateBurstPolicy,
): Promise<boolean> {
  const readyIn = await repository.privateBurstReadyIn(window);
  if (readyIn === null) return false;
  await new Promise((resolve) => setTimeout(resolve, readyIn + HELD_CHAT_WAKE_MARGIN_MILLISECONDS));
  return true;
}

// Seen with a tool result by a running turn of this chat: such a message carries its own notice.
const DELIVERED_SQL = `EXISTS (SELECT 1 FROM telegram_turn_interjections seen
  WHERE seen.update_id = candidate.update_id AND seen.delivered_at IS NOT NULL)`;

/**
 * Returns the payloads of the head's burst in chat order, or null for a message handled alone. New
 * followers join only while the head has never been handed to Eve; after that the burst is fixed.
 */
export async function joinTelegramBurst(
  client: PoolClient,
  head: { dispatchStarted: boolean; payload: Record<string, unknown>; queueId: string; updateId: string },
  policy: TelegramPrivateBurstPolicy,
): Promise<Record<string, unknown>[] | null> {
  const chat = (head.payload.message as { chat?: { type?: unknown } } | undefined)?.chat;
  if (chat?.type !== "private") return null;
  if (!head.dispatchStarted) {
    const found = await client.query<{ delivered: boolean; payload: Record<string, unknown>; update_id: string }>(
      `SELECT candidate.update_id::text, candidate.payload, ${DELIVERED_SQL} AS delivered
         FROM telegram_ingress_updates candidate
        WHERE candidate.queue_id = $1 AND candidate.update_id >= $2 AND candidate.status IN ('pending', 'processing')
          -- An album stays in the list so the burst stops at it; its own members follow it, not us.
          AND candidate.media_group_leader_id IS NULL
        ORDER BY candidate.update_id
        LIMIT $3
        FOR UPDATE`,
      [head.queueId, head.updateId, policy.maxMessages],
    );
    const [leader, ...followers] = found.rows.map((row) => ({ delivered: row.delivered, payload: row.payload, updateId: row.update_id }));
    if (leader?.updateId !== head.updateId) {
      throw new AppError("AGENT_TELEGRAM_BURST_INVALID", "Не удалось собрать несколько сообщений подряд в одно. Отправьте их ещё раз");
    }
    const members = selectTelegramBurstMembers(leader, followers, policy);
    if (members.length > 0) {
      await client.query(
        `UPDATE telegram_ingress_updates SET media_group_leader_id = $1, updated_at = now()
          WHERE update_id = ANY($2::bigint[]) AND status = 'pending' AND media_group_leader_id IS NULL`,
        [head.updateId, members],
      );
    }
  }
  const joined = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM telegram_ingress_updates
      WHERE media_group_leader_id = $1 AND NOT media_group_late
      ORDER BY update_id`,
    [head.updateId],
  );
  return joined.rows.length === 0 ? null : [head.payload, ...joined.rows.map((row) => row.payload)];
}
