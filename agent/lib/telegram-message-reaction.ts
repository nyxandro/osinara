/**
 * Telegram current-message reaction delivery.
 *
 * Exports:
 * - `TelegramMessageReactionEmoji`: one model-selected emoji grapheme.
 * - `TelegramMessageReactionResult`: applied or provider-restricted delivery outcome.
 * - `isTelegramMessageReactionEmoji`: strict single-emoji reaction directive guard.
 * - `setTelegramMessageReaction`: confirmed Bot API reaction on a verified inbound message.
 */
import type { TelegramHandle } from "../runtime/telegram/channel-types.js";

import { AppError } from "./app-error.js";

const EMOJI_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const KEYCAP_EMOJI_PATTERN = /^[#*0-9]\uFE0F?\u20E3$/u;
const REGIONAL_FLAG_PATTERN = /^\p{Regional_Indicator}{2}$/u;
const TELEGRAM_MESSAGE_ID_PATTERN = /^[1-9]\d*$/u;
const TELEGRAM_REACTION_DECLINED_STATUSES = new Set([400, 403]);

export type TelegramMessageReactionResult = "applied" | "unavailable";

export type TelegramMessageReactionEmoji = string;

export function isTelegramMessageReactionEmoji(
  value: string,
): value is TelegramMessageReactionEmoji {
  const graphemes = Array.from(EMOJI_GRAPHEME_SEGMENTER.segment(value));
  return graphemes.length === 1 && graphemes[0]?.segment === value &&
    (EXTENDED_PICTOGRAPHIC_PATTERN.test(value) || KEYCAP_EMOJI_PATTERN.test(value) ||
      REGIONAL_FLAG_PATTERN.test(value));
}

export async function setTelegramMessageReaction(
  telegram: Pick<TelegramHandle, "chatId" | "request">,
  messageId: string,
  emoji: TelegramMessageReactionEmoji,
): Promise<TelegramMessageReactionResult> {
  if (!TELEGRAM_MESSAGE_ID_PATTERN.test(messageId) || !Number.isSafeInteger(Number(messageId))) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_TARGET_INVALID",
      "Telegram передал некорректное сообщение для реакции",
    );
  }

  // The exact channel context and verified inbound message are the only reaction target.
  let response;
  try {
    response = await telegram.request("setMessageReaction", {
      chat_id: telegram.chatId,
      is_big: false,
      message_id: Number(messageId),
      reaction: [{ emoji, type: "emoji" }],
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      method: "setMessageReaction",
    }));
    if (error instanceof Error) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_TELEGRAM_REACTION_DELIVERY_FAILED: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }

  const body = response.body as { description?: unknown; ok?: unknown; result?: unknown } | null;
  if (response.ok && body?.ok === true && body.result === true) return "applied";

  // Disabled or restricted chat reactions are an expected presentation limitation, not turn failure.
  // The refused emoji and the provider description are what separate an unsupported symbol from a
  // chat that forbids reactions outright; without them both look identical in the journal.
  if (body?.ok === false && TELEGRAM_REACTION_DECLINED_STATUSES.has(response.status)) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_UNAVAILABLE",
      emoji,
      method: "setMessageReaction",
      providerDescription: typeof body.description === "string" ? body.description : null,
      providerStatus: response.status,
    }));
    return "unavailable";
  }

  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    emoji,
    method: "setMessageReaction",
    providerDescription: typeof body?.description === "string" ? body.description : null,
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    "Telegram не принял реакцию. Проверьте, разрешены ли реакции в этом чате",
  );
}
