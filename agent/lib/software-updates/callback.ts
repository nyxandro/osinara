/**
 * Application-owned Telegram callback boundary for software update decisions.
 *
 * Exports:
 * - `createSoftwareUpdateCallbackHandler`: exact, one-shot callback processor.
 * - `handleSoftwareUpdateCallback`: production durable-ingress callback handler.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";

import { softwareUpdateRepository } from "./repository.js";
import { softwareUpdateTelegramTransport } from "./telegram-transport.js";
import type {
  SoftwareUpdateRepository,
  SoftwareUpdateTelegramTransport,
} from "./types.js";

export const SOFTWARE_UPDATE_CALLBACK_PREFIX = "su:";
const CALLBACK_PATTERN = /^su:([ad]):([A-Za-z0-9_-]{12,43})$/;
const CALLBACK_MESSAGES = {
  approved: "Обновление подтверждено. Система обновлений установит его отдельно.",
  declined: "Обновление отложено. Повторного предложения для этой версии не будет.",
  expired:
    "AGENT_SOFTWARE_UPDATE_EXPIRED: Это предложение уже использовано или больше не действует.",
  forbidden:
    "AGENT_SOFTWARE_UPDATE_FORBIDDEN: Решение может принять только текущий владелец в исходном личном чате.",
} as const;

interface SoftwareUpdateCallbackDependencies {
  repository: Pick<
    SoftwareUpdateRepository,
    "claimDecision" | "recordDecisionUiFailure"
  >;
  transport: Pick<SoftwareUpdateTelegramTransport, "answerCallback" | "removeKeyboard">;
}

export function createSoftwareUpdateCallbackHandler(
  dependencies: SoftwareUpdateCallbackDependencies,
) {
  async function answerWithoutDecision(
    callbackQueryId: string,
    status: "expired" | "forbidden",
  ): Promise<void> {
    try {
      await dependencies.transport.answerCallback({
        callbackQueryId,
        showAlert: true,
        text: CALLBACK_MESSAGES[status],
      });
    } catch (error) {
      // Callback UI is best-effort only after the durable authorization result is known.
      console.error(JSON.stringify({
        callbackQueryId,
        code: "AGENT_SOFTWARE_UPDATE_CALLBACK_ANSWER_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function recordUiFailure(proposalId: string, error: unknown): Promise<void> {
    const failure = {
      code: "AGENT_SOFTWARE_UPDATE_CALLBACK_UI_FAILED",
      message: "Telegram не подтвердил обновление интерфейса после сохранения решения",
      proposalId,
    };
    console.error(JSON.stringify({
      ...failure,
      error: error instanceof Error ? error.message : String(error),
    }));
    try {
      await dependencies.repository.recordDecisionUiFailure(failure);
    } catch (recordError) {
      // The owner decision is already committed and must never be rolled back by UI bookkeeping.
      console.error(JSON.stringify({
        code: "AGENT_SOFTWARE_UPDATE_CALLBACK_UI_STATE_FAILED",
        error: recordError instanceof Error ? recordError.message : String(recordError),
        proposalId,
      }));
    }
  }

  return async function handleSoftwareUpdateCallback(
    query: TelegramCallbackQuery,
  ): Promise<boolean> {
    const data = query.data;
    if (!data?.startsWith(SOFTWARE_UPDATE_CALLBACK_PREFIX)) return false;
    const parsed = CALLBACK_PATTERN.exec(data);
    const message = query.message;
    if (!parsed || !message) {
      await answerWithoutDecision(query.id, "expired");
      return true;
    }

    // PostgreSQL atomically verifies every Telegram binding and the current owner role.
    const result = await dependencies.repository.claimDecision({
      action: parsed[1] === "a" ? "approve" : "decline",
      callbackQueryId: query.id,
      callbackToken: parsed[2]!,
      telegramChatId: message.chat.id,
      telegramChatType: message.chat.type,
      telegramMessageId: message.messageId,
      telegramUserId: query.from.id,
    });
    if (result.status === "expired" || result.status === "forbidden") {
      await answerWithoutDecision(query.id, result.status);
      return true;
    }

    // UI operations happen strictly after commit and cannot change the stored decision.
    try {
      await dependencies.transport.removeKeyboard({
        chatId: message.chat.id,
        messageId: message.messageId,
      });
    } catch (error) {
      await recordUiFailure(result.proposalId, error);
    }
    try {
      await dependencies.transport.answerCallback({
        callbackQueryId: query.id,
        text: CALLBACK_MESSAGES[result.status],
      });
    } catch (error) {
      await recordUiFailure(result.proposalId, error);
    }
    return true;
  };
}

export const handleSoftwareUpdateCallback = createSoftwareUpdateCallbackHandler({
  repository: softwareUpdateRepository,
  transport: softwareUpdateTelegramTransport,
});
