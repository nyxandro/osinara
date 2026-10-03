/**
 * Live per-chat Telegram reaction policy.
 *
 * Exports:
 * - `TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS`: window in which a cached policy stays verified.
 * - `TelegramReactionPolicy`: whether the chat accepts any emoji or an explicit list.
 * - `telegramReactionPolicyEmoji`: parses the verified getChat answer.
 * - `refreshTelegramReactionPolicy`: refreshes the cached policy of one chat when it is stale.
 *
 * Key construct:
 * - An absent `available_reactions` documents that every emoji reaction is allowed, so the two
 *   states are read from the provider answer and never guessed. An unknown policy stays unknown:
 *   the prompt then offers no reaction surface at all. A record older than the refresh window means
 *   the refresh keeps failing, so it stops counting as verified instead of describing a stale set.
 */
import type { TelegramHandle } from "../runtime/telegram/channel-types.js";

import { isAppError } from "./app-error.js";
import { telegramReactionPolicyRepository } from "./telegram-reaction-policy-repository.js";

export const TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface TelegramReactionPolicy {
  readonly allowsAll: boolean;
  readonly emoji: readonly string[];
}

interface ReactionTypeEntry {
  readonly emoji?: unknown;
  readonly type?: unknown;
}

export function telegramReactionPolicyEmoji(result: unknown): TelegramReactionPolicy {
  const available = (result as { available_reactions?: unknown } | null)?.available_reactions;
  // Bot API: the field is omitted exactly when every emoji reaction is allowed in the chat.
  if (available === undefined || available === null) return { allowsAll: true, emoji: [] };
  if (!Array.isArray(available)) {
    throw new Error("AGENT_TELEGRAM_REACTION_POLICY_INVALID: available_reactions is not a list");
  }

  // Bots cannot send paid reactions, and custom emoji are not addressable by grapheme.
  const emoji = (available as ReactionTypeEntry[])
    .filter((entry) => entry?.type === "emoji" && typeof entry.emoji === "string")
    .map((entry) => entry.emoji as string);
  return { allowsAll: false, emoji };
}

export async function refreshTelegramReactionPolicy(
  telegram: Pick<TelegramHandle, "chatId" | "request">,
): Promise<void> {
  try {
    const cached = await telegramReactionPolicyRepository.read(telegram.chatId);
    if (
      cached &&
      Date.now() - cached.fetchedAt.getTime() < TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS
    ) return;

    const response = await telegram.request("getChat", { chat_id: telegram.chatId });
    const body = response.body as { ok?: unknown; result?: unknown } | null;
    if (!response.ok || body?.ok !== true) {
      throw new Error(
        `AGENT_TELEGRAM_REACTION_POLICY_LOOKUP_FAILED: getChat returned ${response.status}`,
      );
    }
    await telegramReactionPolicyRepository.save(
      telegram.chatId,
      telegramReactionPolicyEmoji(body.result),
    );
  } catch (error) {
    // A stale or missing policy only removes the reaction surface from the prompt for this turn.
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_POLICY_REFRESH_FAILED",
      errorCode: isAppError(error) ? error.code : null,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}
