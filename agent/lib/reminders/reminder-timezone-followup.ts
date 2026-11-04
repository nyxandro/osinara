/**
 * The bot's own questions about a timezone it does not know (#451).
 *
 * Exports:
 * - `followupText`: the message for one person's due waits.
 * - `createTimezoneFollowups`: one minute's pass — ends overdue waits, then asks about the due ones.
 * - `productionTimezoneFollowups`: the same over Telegram and PostgreSQL.
 *
 * Key constructs:
 * - One `UPDATE … RETURNING` takes the due waits whose author still has no zone and counts the
 *   question before it is sent; one send follows. A crash in between loses at most this question and
 *   never repeats one, as with reminders: an unclear send is not retried.
 * - One message per person in a pass, with the buttons «Да, {город}» and «Другой пояс». A press
 *   reaches the agent as the person's message, which saves the zone and so sets the waits. The
 *   message is recorded in the chat history so the agent understands a later reply.
 * - A wait whose clock time has passed everywhere ends without a message; whether its question's
 *   button was pressed is kept, because then the agent failed to save the zone.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";
import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { localParts } from "../calendar-mirror/calendar-mirror-local-time.js";
import { database } from "../database.js";
import { type ProactiveDeliveryInput, proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import { newReplyButtonToken, type ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { replyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";
import { telegramRichMessageRequest } from "../telegram-rich-messages.js";
import { REMINDER_TZ_FOLLOWUP_MIN_GAP_MINUTES } from "./reminder-config.js";
import { suggestedTimezoneOf, timezoneLabel } from "./reminder-timezone-wait-repository.js";

const OTHER_ZONE_BUTTON = "Другой пояс";
const DELIVERY_TITLE = "Часовой пояс для напоминаний";
const CONTENT_PREVIEW_LENGTH = 60;
const LISTED_WAITS = 5;
const TELEGRAM_BAD_REQUEST_STATUS = 400;

export interface FollowupWait {
  content: string;
  localFirstRun: string;
}

interface TelegramAnswer {
  body: unknown;
  ok: boolean;
  status: number;
}

export interface TimezoneFollowupDependencies {
  buttons: {
    activate(id: string, messageId: string): Promise<void>;
    discard(id: string): Promise<void>;
    stage(input: { addresseeTelegramUserId: string; buttons: ReplyButtonRows; messageText: string; telegramChatId: string }): Promise<{ id: string; markdown: string }>;
  };
  recordDelivery(delivery: ProactiveDeliveryInput): Promise<void>;
  send(method: "sendMessage" | "sendRichMessage", body: JsonObject): Promise<TelegramAnswer>;
}

interface DueRow {
  author_user_id: string;
  chat_id: string;
  content: string;
  family_id: string;
  followups_sent: number;
  id: string;
  local_first_run: string;
}

function preview(content: string): string {
  return content.length > CONTENT_PREVIEW_LENGTH ? `${content.slice(0, CONTENT_PREVIEW_LENGTH - 1)}…` : content;
}

function clock(localFirstRun: string): string {
  return localFirstRun.slice(11, 16);
}

/** «среда, 4 ноября, 12:20» from the clock time the person named. */
function when(localFirstRun: string): string {
  const parts = localParts(localFirstRun);
  const day = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long", timeZone: "UTC", weekday: "long" })
    .format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
  return `${day}, ${clock(localFirstRun)}`;
}

export function followupText(waits: readonly FollowupWait[], zoneLabel: string, followupNumber: number): string {
  if (waits.length > 1) {
    const listed = waits.slice(0, LISTED_WAITS).map((wait) => `«${preview(wait.content)}» (${when(wait.localFirstRun)})`);
    const more = waits.length > LISTED_WAITS ? ` и ещё ${waits.length - LISTED_WAITS}` : "";
    return `Пока не поставлены напоминания: ${listed.join(", ")}${more} — не знаю ваш часовой пояс. Ваш пояс — ${zoneLabel}?`;
  }
  const wait = waits[0]!;
  return followupNumber >= 2
    ? `Сегодня у вас «${preview(wait.content)}» в ${clock(wait.localFirstRun)}, но напоминание так и не поставлено — не знаю ваш часовой пояс. Если ваш пояс — ${zoneLabel}, нажмите кнопку, и я поставлю.`
    : `Напоминание «${preview(wait.content)}» (${when(wait.localFirstRun)}) пока не поставлено: я не знаю ваш часовой пояс. Ваш пояс — ${zoneLabel}?`;
}

function messageIdOf(answer: TelegramAnswer): string | null {
  const result = (answer.body as { result?: { message_id?: unknown } } | null)?.result;
  return typeof result?.message_id === "number" ? String(result.message_id) : null;
}

async function expireOverdue(now: Date): Promise<number> {
  const expired = await database().query<{ family_id: string; followup_pressed: boolean; id: string }>(
    `UPDATE reminder_timezone_waits AS wait
     SET status = 'expired', resolved_at = $1, next_followup_at = NULL, updated_at = $1,
         followup_pressed = EXISTS (
           SELECT 1 FROM telegram_reply_button_sets AS button
           WHERE button.id = wait.last_followup_button_id AND button.status = 'selected'
         )
     WHERE wait.status = 'waiting' AND wait.expires_at <= $1
     RETURNING wait.id, wait.family_id, wait.followup_pressed`,
    [now],
  );
  for (const row of expired.rows) {
    console.info(JSON.stringify({
      code: "AGENT_REMINDER_AWAITING_EXPIRED", familyId: row.family_id, followupPressed: row.followup_pressed, waitId: row.id,
    }));
  }
  return expired.rows.length;
}

async function claimDue(now: Date): Promise<DueRow[]> {
  const claimed = await database().query<DueRow>(
    `UPDATE reminder_timezone_waits AS wait
     SET followups_sent = wait.followups_sent + 1,
         next_followup_at = CASE
           WHEN wait.followups_sent = 0 AND wait.second_followup_at >= $1::timestamptz + make_interval(mins => $2)
             THEN wait.second_followup_at
         END,
         updated_at = $1
     FROM users AS author
     WHERE author.id = wait.author_user_id AND wait.status = 'waiting' AND wait.next_followup_at <= $1
       AND wait.followups_sent < 2
       AND NOT EXISTS (SELECT 1 FROM user_notification_settings AS settings WHERE settings.user_id = wait.author_user_id)
     RETURNING wait.id, wait.family_id, wait.author_user_id, wait.content, wait.followups_sent,
               to_char(wait.local_first_run, 'YYYY-MM-DD"T"HH24:MI:SS') AS local_first_run,
               author.telegram_user_id AS chat_id`,
    [now, REMINDER_TZ_FOLLOWUP_MIN_GAP_MINUTES],
  );
  return claimed.rows;
}

async function recordOutcome(ids: readonly string[], outcome: { buttonId: string | null; errorCode: string | null; messageId: string | null }) {
  await database().query(
    `UPDATE reminder_timezone_waits
     SET last_followup_message_id = COALESCE($2, last_followup_message_id),
         last_followup_button_id = COALESCE($3, last_followup_button_id),
         last_followup_error_code = $4
     WHERE id = ANY($1::uuid[])`,
    [ids, outcome.messageId, outcome.buttonId, outcome.errorCode],
  );
}

async function deliver(
  dependencies: TimezoneFollowupDependencies,
  chatId: string,
  text: string,
  buttons: ReplyButtonRows,
): Promise<{ buttonId: string | null; messageId: string }> {
  const staged = await dependencies.buttons.stage({ addresseeTelegramUserId: chatId, buttons, messageText: text, telegramChatId: chatId });
  const rich = telegramRichMessageRequest({ chat_id: chatId }, staged.markdown, []);
  let answer = await dependencies.send("sendRichMessage", (rich as { body: JsonObject }).body);
  let buttonId: string | null = staged.id;
  if (!answer.ok) {
    // A refusal delivered nothing: the prepared buttons go away and the words still go out.
    await dependencies.buttons.discard(staged.id);
    buttonId = null;
    if (answer.status === TELEGRAM_BAD_REQUEST_STATUS) answer = await dependencies.send("sendMessage", { chat_id: chatId, text });
  }
  const messageId = answer.ok ? messageIdOf(answer) : null;
  if (messageId === null) throw new Error(`AGENT_REMINDER_TIMEZONE_FOLLOWUP_REJECTED: Telegram status ${answer.status}`);
  if (buttonId !== null) await dependencies.buttons.activate(buttonId, messageId);
  return { buttonId, messageId };
}

export function createTimezoneFollowups(dependencies: TimezoneFollowupDependencies) {
  return {
    async dispatch(now: Date): Promise<{ expired: number; failed: number; sent: number }> {
      const expired = await expireOverdue(now);
      const due = await claimDue(now);
      const byAuthor = new Map<string, DueRow[]>();
      for (const row of due) byAuthor.set(row.author_user_id, [...byAuthor.get(row.author_user_id) ?? [], row]);
      let sent = 0;
      let failed = 0;
      for (const rows of byAuthor.values()) {
        const ids = rows.map((row) => row.id);
        const first = rows[0]!;
        try {
          const label = timezoneLabel(await suggestedTimezoneOf(database(), first.family_id));
          const ordered = [...rows].sort((left, right) => left.local_first_run.localeCompare(right.local_first_run));
          const text = followupText(
            ordered.map((row) => ({ content: row.content, localFirstRun: row.local_first_run })),
            label,
            Math.max(...rows.map((row) => row.followups_sent)),
          );
          const delivered = await deliver(dependencies, first.chat_id, text, [[{ text: `Да, ${label}` }, { text: OTHER_ZONE_BUTTON }]]);
          await recordOutcome(ids, { ...delivered, errorCode: null });
          try {
            await dependencies.recordDelivery({
              content: text, deliveredAt: now, familyId: first.family_id, groupId: null, messageThreadId: null,
              ownerUserId: first.author_user_id, scheduledFor: now, scope: "personal", sourceId: first.id,
              sourceKind: "reminder_timezone_followup", telegramChatId: first.chat_id, telegramMessageId: delivered.messageId,
              title: DELIVERY_TITLE,
            });
          } catch (error) {
            // The question went out; only the chat history misses it, so the agent may not see it.
            console.error(JSON.stringify({
              code: "AGENT_REMINDER_TIMEZONE_FOLLOWUP_HISTORY_FAILED",
              error: error instanceof Error ? error.message : String(error),
              familyId: first.family_id,
            }));
          }
          console.info(JSON.stringify({ code: "AGENT_REMINDER_TIMEZONE_FOLLOWUP_SENT", familyId: first.family_id, waits: ids.length }));
          sent += 1;
        } catch (error) {
          failed += 1;
          await recordOutcome(ids, { buttonId: null, errorCode: "AGENT_REMINDER_TIMEZONE_FOLLOWUP_FAILED", messageId: null });
          console.error(JSON.stringify({
            code: "AGENT_REMINDER_TIMEZONE_FOLLOWUP_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: first.family_id,
            waits: ids.length,
          }));
        }
      }
      return { expired, failed, sent };
    },
  };
}

function requireBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для вопросов о часовом поясе");
  return botToken;
}

export const productionTimezoneFollowups = createTimezoneFollowups({
  buttons: {
    async activate(id, messageId) {
      await replyButtonRepository.activate(id, messageId, []);
    },
    async discard(id) {
      await replyButtonRepository.discard(id);
    },
    async stage(input) {
      const set = await replyButtonRepository.stageForReminder({
        ...input, reminderId: null, telegramChatType: "private", token: newReplyButtonToken(),
      });
      return { id: set.id, markdown: `${input.messageText}\n\n${replyButtonMarkup(set.buttons, set.token)}` };
    },
  },
  recordDelivery: (delivery) => proactiveDeliveryRepository.record(delivery),
  async send(method, body) {
    const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
    return await callTelegramApi({
      body,
      botToken: requireBotToken(),
      fetch: (request, init) => fetch(request, { ...init, signal }),
      method,
    });
  },
});
