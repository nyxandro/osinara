/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `CompletedTelegramOutput`: final message, silent reaction, deliberate silence, or interim
 *   progress decision.
 * - `completedTelegramOutput`: validates model output before Telegram delivery.
 *
 * Provider adapters route typed reasoning parts to dedicated Eve events that this delivery
 * policy never receives.
 */
import { AppError } from "./app-error.js";
import { EVE_EMPTY_DELIVERY_MARKER } from "./eve-empty-delivery.js";
import { stripTelegramAsideDirectives } from "./telegram-authored-split.js";
import {
  isTelegramMessageReactionEmoji,
  type TelegramMessageReactionEmoji,
} from "./telegram-message-reaction.js";

const TOOL_CALLS_FINISH_REASON = "tool-calls";
const TELEGRAM_REACTION_DIRECTIVE_PATTERN =
  /^<telegram-reaction>(?<emoji>[^<]*)<\/telegram-reaction>$/u;
const TELEGRAM_REACTION_DIRECTIVE_FRAGMENT = "telegram-reaction";

export type CompletedTelegramOutput =
  | { emoji: TelegramMessageReactionEmoji; kind: "reaction" }
  | { kind: "message"; message: string }
  | { kind: "progress"; message: string }
  | { kind: "silence" };

export function completedTelegramOutput(data: {
  finishReason: string;
  message?: string | null;
}): CompletedTelegramOutput | null {
  // Eve reports a final step the model marked as undelivered with `message: null`; that is the
  // model's deliberate silence, while a blank step is technical noise.
  if (data.message === null && data.finishReason !== TOOL_CALLS_FINISH_REASON) {
    return { kind: "silence" };
  }
  // Only completed visible assistant text should become a durable Telegram message.
  const message =
    data.message === undefined || data.message === null ? "" : data.message.trim();
  if (!message) return null;

  // Text authored before a tool call is what a person reads while a long task runs.
  if (data.finishReason === TOOL_CALLS_FINISH_REASON) {
    const progress = stripTelegramAsideDirectives(message);
    // Transport directives belong to the final answer; interim noise is dropped, never delivered.
    if (
      !progress ||
      progress.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT) ||
      progress.includes(EVE_EMPTY_DELIVERY_MARKER)
    ) {
      return null;
    }
    return { kind: "progress", message: progress };
  }

  // Reaction is a terminal transport directive and can never be mixed with user-visible text.
  const reaction = TELEGRAM_REACTION_DIRECTIVE_PATTERN.exec(message)?.groups?.emoji;
  if (reaction !== undefined && isTelegramMessageReactionEmoji(reaction)) {
    return { emoji: reaction, kind: "reaction" };
  }
  if (message.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT)) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID",
      "Не удалось выбрать безопасную реакцию на сообщение",
    );
  }
  // An answer made of transport directives alone has no visible content to deliver.
  if (!stripTelegramAsideDirectives(message)) return null;
  return { kind: "message", message };
}
