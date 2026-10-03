/**
 * Shared Telegram group journal integration fixtures.
 *
 * Exports:
 * - `recordVerifiedHumanTelegramMessage`: records a fixture only after production actor validation.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { telegramInboundActor } from "./telegram-inbound-actor.js";

export async function recordVerifiedHumanTelegramMessage(
  groupId: string,
  message: TelegramMessage,
) {
  // Integration fixtures use ordinary users; rejecting any other projection keeps actor provenance
  // explicit while avoiding duplicated actor literals throughout journal tests.
  const actor = telegramInboundActor(message);
  if (actor?.kind !== "telegram_user") {
    throw new Error(
      "AGENT_TEST_TELEGRAM_ACTOR_INVALID: Ожидалось тестовое сообщение от Telegram-пользователя",
    );
  }
  return telegramGroupJournalRepository.record(groupId, message, actor);
}
