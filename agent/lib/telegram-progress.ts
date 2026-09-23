/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `CompletedTelegramOutput`: final message (a reply or a standalone message), silent reaction,
 *   deliberate silence, or interim progress decision.
 * - `completedTelegramOutput`: validates model output before Telegram delivery.
 * - `telegramOutputWithoutMemoryDirective`: the same decision, taken on text the memory-usage
 *   line has already been removed from, plus what that line named.
 *
 * The memory-usage line is transport syntax and the model writes it on every step that produces
 * text — the progress note before a tool call and the message carrying a reaction directive
 * included. It is removed here, ahead of the decision, so no branch can deliver it and so a
 * reaction is still recognized as the whole message it has to be.
 *
 * Provider adapters route typed reasoning parts to dedicated Eve events that this delivery
 * policy never receives.
 */
import { AppError } from "./app-error.js";
import { EVE_EMPTY_DELIVERY_MARKER } from "./eve-empty-delivery.js";
import {
  readMemoryUsageDirective,
  type MemoryUsageDeclaration,
} from "./memory-usage-directive.js";
import { stripTelegramAsideDirectives } from "./telegram-authored-split.js";
import { readTelegramStandaloneDirective } from "./telegram-standalone-directive.js";
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
  | { kind: "message"; message: string; standalone: boolean }
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
    const progress = stripTelegramAsideDirectives(readTelegramStandaloneDirective(message).markdown);
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

  // The reply choice is removed first, so a reaction is still recognized as the whole message.
  const { markdown: answer, standalone } = readTelegramStandaloneDirective(message);

  // Reaction is a terminal transport directive and can never be mixed with user-visible text.
  const reaction = TELEGRAM_REACTION_DIRECTIVE_PATTERN.exec(answer)?.groups?.emoji;
  if (reaction !== undefined && isTelegramMessageReactionEmoji(reaction)) {
    return { emoji: reaction, kind: "reaction" };
  }
  if (answer.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT)) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID",
      "Не удалось выбрать безопасную реакцию на сообщение",
    );
  }
  // An answer made of transport directives alone has no visible content to deliver.
  if (!stripTelegramAsideDirectives(answer)) return null;
  return { kind: "message", message: answer, standalone };
}

export function telegramOutputWithoutMemoryDirective(data: {
  finishReason: string;
  message?: string | null;
}): { declaration: MemoryUsageDeclaration; output: CompletedTelegramOutput | null } {
  // `null` is the model's deliberate silence and has to stay `null` all the way through.
  if (typeof data.message !== "string") {
    return {
      declaration: { answer: "", declared: false, memoryRefs: [] },
      output: completedTelegramOutput(data),
    };
  }
  const declaration = readMemoryUsageDirective(data.message);
  return {
    declaration,
    output: completedTelegramOutput({ ...data, message: declaration.answer }),
  };
}
