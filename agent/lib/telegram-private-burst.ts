/**
 * Private-chat bursts: a person often sends several messages in a row.
 *
 * Exports:
 * - `requireTelegramPrivateBurstWindow`: fail-fast validation of the quiet window and its cap.
 * - `telegramPrivateBurstRepository`: when the next held private chat becomes ready, and whether a
 *   message of a private chat already has another message waiting behind it.
 * - `waitForHeldPrivateChat`: lets an idle drain sleep until a held chat is ready, instead of
 *   leaving the reply to the next five-second poll.
 *
 * Key constructs:
 * - The head of a private chat is claimed only after the chat has been quiet for the window, so a
 *   burst is complete before the first of its messages is handled.
 * - Each message but the last of a burst is written to the conversation without a turn. The last one
 *   starts the turn, and the conversation timeline shows the model the whole burst in order.
 * - A button press behind a message ends the burst: it answers an agent's question, not the message.
 *   So does a message without content that could start a turn, such as a lone sticker: the message
 *   before it would otherwise wait unanswered for the person's next one.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  requireUpdateId,
  type TelegramIngressRepository,
  type TelegramPrivateBurstWindow,
} from "./telegram-ingress-contract.js";

// Telegram message fields whose content an ordinary private turn handles.
const TURN_CONTENT_FIELDS = ["animation", "audio", "caption", "document", "photo", "text", "video", "voice"];
// The claim reads the clock after the timer fires; this margin keeps it past the ready moment.
const HELD_CHAT_WAKE_MARGIN_MILLISECONDS = 50;

export function requireTelegramPrivateBurstWindow(window: TelegramPrivateBurstWindow): TelegramPrivateBurstWindow {
  const { maxWaitMilliseconds, quietMilliseconds } = window;
  if (![maxWaitMilliseconds, quietMilliseconds].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    maxWaitMilliseconds < quietMilliseconds) {
    throw new AppError(
      "AGENT_TELEGRAM_BURST_WINDOW_INVALID",
      "Пауза перед ответом в личном чате задана неверно",
    );
  }
  return window;
}

export const telegramPrivateBurstRepository = {
  async readyInMilliseconds(window: TelegramPrivateBurstWindow): Promise<number | null> {
    requireTelegramPrivateBurstWindow(window);
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

  async hasFollowingMessage(updateId: string): Promise<boolean> {
    const result = await database().query<{ message: boolean }>(
      `SELECT COALESCE(next.payload -> 'message' ?| $2::text[], false) AS message
         FROM telegram_ingress_updates current
         JOIN LATERAL (
           SELECT later.payload FROM telegram_ingress_updates later
            WHERE later.queue_id = current.queue_id AND later.update_id > current.update_id
              AND later.status = 'pending' AND (later.media_group_leader_id IS NULL OR later.media_group_late)
            ORDER BY later.update_id
            LIMIT 1
         ) next ON true
        WHERE current.update_id = $1`,
      [requireUpdateId(updateId), TURN_CONTENT_FIELDS],
    );
    return result.rows[0]?.message === true;
  },
};

/** True after sleeping until a held private chat is ready, so the caller claims again; false when none is held. */
export async function waitForHeldPrivateChat(
  repository: Pick<TelegramIngressRepository, "privateBurstReadyIn">,
  window: TelegramPrivateBurstWindow,
): Promise<boolean> {
  const readyIn = await repository.privateBurstReadyIn(window);
  if (readyIn === null) return false;
  await new Promise((resolve) => setTimeout(resolve, readyIn + HELD_CHAT_WAKE_MARGIN_MILLISECONDS));
  return true;
}
