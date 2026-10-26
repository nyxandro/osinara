/**
 * A press of a reply button, turned into the addressee's own message.
 *
 * Exports:
 * - `ReplyButtonPressOutcome`: either answered on the spot, or the message the press stands for.
 * - `createReplyButtonPressHandler`: the press boundary over the repository and Telegram.
 * - `handleReplyButtonPress`: the production handler.
 * - `REPLY_BUTTON_PRESS_MESSAGE_ID_BASE`: where the message numbers of presses begin.
 *
 * Key constructs:
 * - Only the addressee's press counts; anyone else sees a pop-up and nothing changes.
 * - A replayed press answers and settles its message again: before a crash it cannot be known
 *   whether that happened. A press on buttons already decided settles them again too.
 * - The press becomes an ordinary inbound message from the presser and goes through the same
 *   authorization, queue, history and memory as typed text: it authorizes nothing more than the
 *   words on the button would.
 * - A press has no Telegram message number, so it gets one far above any real one, derived from
 *   its update id: a replay after a crash rebuilds exactly the same message.
 * - In a group it is a reply to the buttons' message, which is what addresses it to the agent there.
 *   In a private chat it is a reply only when that message belongs to a conversation that takes
 *   replies, so the answer lands where the question was asked; a reply to a bot message no
 *   conversation owns (a reminder, a scenario report) would open a separate one, and a conversation
 *   waiting for an approval turns replies away, so then it goes to the main conversation.
 *   In both, its text quotes the message the button was under.
 */
import { parseTelegramUpdate, type TelegramCallbackQuery, type TelegramMessage } from "../../runtime/telegram/inbound.js";

import { AppError } from "../app-error.js";
import { telegramBaseContinuationToken } from "../telegram-reply-routing.js";
import {
  DISMISSED_REPLY_CAPTION,
  parseReplyButtonCallback,
  replyButtonLabels,
  selectedReplyCaption,
} from "./reply-button-contract.js";
import { replyButtonRepository, type ReplyButtonSet } from "./reply-button-repository.js";
import { replyButtonTelegram, type ReplyButtonTelegram } from "./reply-button-telegram.js";

export const REPLY_BUTTON_PRESS_MESSAGE_ID_BASE = 2 ** 40;
const REPLY_BUTTON_QUOTE_MAX_CHARACTERS = 300;
const PRESS_NOT_FOR_YOU = "Эти кнопки предназначены не вам";
const PRESS_EXPIRED = "Эти кнопки уже не действуют";

export type ReplyButtonPressOutcome =
  | { status: "answered" }
  | { buttonMessageId: string; message: TelegramMessage; status: "message" };

interface ReplyButtonPressDependencies {
  repository: Pick<typeof replyButtonRepository, "claimPress" | "replyRouteIsOpen">;
  telegram: ReplyButtonTelegram;
}

function quote(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= REPLY_BUTTON_QUOTE_MAX_CHARACTERS
    ? flat
    : `${characters.slice(0, REPLY_BUTTON_QUOTE_MAX_CHARACTERS).join("").trimEnd()}…`;
}

/** What the model reads as the person's message: the tapped answer and the message it answers. */
export function replyButtonPressText(label: string, messageText: string): string {
  return `[Tapped button «${label}» under your message: «${quote(messageText)}»]`;
}

function presserName(query: TelegramCallbackQuery): string {
  return [query.from.firstName, query.from.lastName].filter(Boolean).join(" ");
}

function rawObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("AGENT_REPLY_BUTTON_PRESS_INVALID", "Telegram передал неполные данные нажатия кнопки", {
      details: { field },
    });
  }
  return value as Record<string, unknown>;
}

function pressMessage(query: TelegramCallbackQuery, set: ReplyButtonSet, updateId: string, reply: boolean): TelegramMessage {
  const update = Number(updateId);
  if (!Number.isSafeInteger(update) || update <= 0 || update >= REPLY_BUTTON_PRESS_MESSAGE_ID_BASE) {
    throw new AppError("AGENT_REPLY_BUTTON_PRESS_INVALID", "Telegram передал некорректный номер обновления для нажатия кнопки");
  }
  if (set.selectedIndex === null || set.messageText === null || set.resolvedAt === null) {
    throw new AppError("AGENT_REPLY_BUTTONS_STATE_INVALID", "Выбор по кнопке не сохранён полностью");
  }
  const label = replyButtonLabels(set.buttons)[set.selectedIndex];
  if (label === undefined) {
    throw new AppError("AGENT_REPLY_BUTTONS_STATE_INVALID", "Нажатая кнопка не найдена в сохранённом наборе");
  }
  const original = rawObject(query.raw.message, "message");
  const raw = {
    chat: original.chat,
    // The moment the press was recorded, so a replay rebuilds the same message.
    date: Math.floor(set.resolvedAt.getTime() / 1_000),
    from: rawObject(query.raw.from, "from"),
    message_id: REPLY_BUTTON_PRESS_MESSAGE_ID_BASE + update,
    text: replyButtonPressText(label, set.messageText),
    ...(original.is_topic_message === true ? { is_topic_message: true } : {}),
    ...(original.message_thread_id === undefined ? {} : { message_thread_id: original.message_thread_id }),
    ...(reply ? { reply_to_message: original } : {}),
  };
  const parsed = parseTelegramUpdate({ message: raw, update_id: update });
  if (parsed?.kind !== "message") {
    throw new AppError("AGENT_REPLY_BUTTON_PRESS_INVALID", "Не удалось превратить нажатие кнопки в сообщение");
  }
  return parsed.message;
}

export function createReplyButtonPressHandler(dependencies: ReplyButtonPressDependencies) {
  async function answer(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await dependencies.telegram.answerPress({ callbackQueryId, ...(text === undefined ? {} : { text }) });
    } catch (error) {
      // The answer only stops the button's spinner; the recorded outcome stands without it.
      console.error(JSON.stringify({
        callbackQueryId,
        code: "AGENT_REPLY_BUTTON_ANSWER_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function settle(set: ReplyButtonSet, caption: string): Promise<void> {
    try {
      await dependencies.telegram.settle(set, caption);
    } catch (error) {
      // The decision is recorded; buttons left on screen are settled by their next press.
      console.error(JSON.stringify({
        code: "AGENT_REPLY_BUTTONS_SETTLE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        setId: set.id,
      }));
    }
  }

  /** The caption of a decided set, for its own press or for cleaning up after a lost edit. */
  function decidedCaption(set: ReplyButtonSet, presser: string | null): string {
    if (set.status === "dismissed" || set.selectedIndex === null) return DISMISSED_REPLY_CAPTION;
    return selectedReplyCaption(replyButtonLabels(set.buttons)[set.selectedIndex]!, presser);
  }

  /**
   * Whether the press answers as a reply: always in a group; in a private chat only into a
   * conversation that owns the message and takes replies, so the choice is never turned away after
   * its caption is shown.
   */
  async function asReply(query: TelegramCallbackQuery, set: ReplyButtonSet, updateId: string): Promise<boolean> {
    if (set.telegramChatType !== "private") return true;
    const reply = pressMessage(query, set, updateId, true);
    return await dependencies.repository.replyRouteIsOpen(telegramBaseContinuationToken(reply));
  }

  return async function handleReplyButtonPress(
    query: TelegramCallbackQuery,
    updateId: string,
  ): Promise<ReplyButtonPressOutcome> {
    const parsed = query.data === undefined ? null : parseReplyButtonCallback(query.data);
    if (parsed === null || query.message === undefined) {
      await answer(query.id, PRESS_EXPIRED);
      return { status: "answered" };
    }
    const claim = await dependencies.repository.claimPress({
      callbackQueryId: query.id,
      index: parsed.index,
      pressedByTelegramUserId: query.from.id,
      telegramChatId: query.message.chat.id,
      telegramMessageId: query.message.messageId,
      token: parsed.token,
    });
    if (claim.status === "forbidden") {
      await answer(query.id, PRESS_NOT_FOR_YOU);
      return { status: "answered" };
    }
    if (claim.status === "expired") {
      await answer(query.id, PRESS_EXPIRED);
      // Buttons still on screen after their decision mean an earlier edit never landed.
      if (claim.decided !== undefined) await settle(claim.decided, decidedCaption(claim.decided, null));
      return { status: "answered" };
    }
    const { set } = claim;
    // A replay after a crash cannot tell whether the answer and the edit landed, so it repeats
    // both; an edit that finds the message already settled is not an error.
    await answer(query.id);
    await settle(set, decidedCaption(set, set.telegramChatType === "private" ? null : presserName(query)));
    return {
      buttonMessageId: set.telegramMessageId!,
      message: pressMessage(query, set, updateId, await asReply(query, set, updateId)),
      status: "message",
    };
  };
}

export const handleReplyButtonPress = createReplyButtonPressHandler({
  repository: replyButtonRepository,
  telegram: replyButtonTelegram,
});
