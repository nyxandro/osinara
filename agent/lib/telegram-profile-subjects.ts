/**
 * Verified Telegram subject-signal extraction for profile selection.
 *
 * Export:
 * - `verifiedTelegramProfileSignals`: exact reply/text_mention IDs, never names or usernames.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function telegramId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  return null;
}

export function verifiedTelegramProfileSignals(message: TelegramMessage): {
  explicitMentionTelegramUserIds: string[];
  replyTelegramUserId: string | null;
} {
  const ids = new Set<string>();
  for (const field of ["entities", "caption_entities"] as const) {
    const entities = message.raw[field];
    if (!Array.isArray(entities)) continue;
    for (const value of entities) {
      const entity = record(value);
      const user = record(entity?.user);
      if (entity?.type !== "text_mention" || user?.is_bot === true) continue;
      const id = telegramId(user?.id);
      if (id) ids.add(id);
    }
  }
  return {
    explicitMentionTelegramUserIds: [...ids].sort(),
    replyTelegramUserId: message.replyToMessage?.from?.isBot === false
      ? telegramId(message.replyToMessage.from.id)
      : null,
  };
}
