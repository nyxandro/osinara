/**
 * Scheduled Telegram final-target binding.
 *
 * Exports:
 * - `SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE`: stable terminal failure code for target drift.
 * - `scheduledTelegramTargetMatches`: compares the active channel target with trusted schedule metadata.
 * - `requireScheduledTelegramTarget`: rejects a mismatched final delivery before side effects.
 */
import { AppError } from "../app-error.js";
import type { ScheduledDeliveryMetadata } from "./scheduled-session.js";

export const SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE =
  "AGENT_SCHEDULE_DELIVERY_TARGET_MISMATCH";

interface ActiveTelegramTarget {
  chatId: string;
  messageThreadId: number | undefined;
}

type ScheduledTelegramTarget = Pick<
  ScheduledDeliveryMetadata,
  "messageThreadId" | "telegramChatId"
>;

export function scheduledTelegramTargetMatches(
  active: ActiveTelegramTarget,
  scheduled: ScheduledTelegramTarget,
): boolean {
  // The channel state holds an active topic as a number, while PostgreSQL-backed auth carries its exact string.
  const activeMessageThreadId = active.messageThreadId === undefined
    ? null
    : String(active.messageThreadId);
  return active.chatId === scheduled.telegramChatId &&
    activeMessageThreadId === scheduled.messageThreadId;
}

export function requireScheduledTelegramTarget(
  active: ActiveTelegramTarget,
  scheduled: ScheduledTelegramTarget,
): void {
  if (scheduledTelegramTargetMatches(active, scheduled)) return;
  throw new AppError(
    SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
    "Доставка расписания отменена: цель Telegram не совпадает с подтверждённым чатом или темой",
  );
}
