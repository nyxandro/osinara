/**
 * Bounded Telegram transport for severe memory-review owner alerts.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertTransportError`: definite Telegram delivery rejection.
 * - `createMemoryReviewOwnerAlertTransport`: injectable no-retry transport.
 * - `memoryReviewOwnerAlertTransport`: lazy production transport using the required bot token.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export class MemoryReviewOwnerAlertTransportError extends AppError {
  readonly delivery: "failed";

  constructor(delivery: "failed", code: string, message: string) {
    super(code, message);
    this.delivery = delivery;
    this.name = "MemoryReviewOwnerAlertTransportError";
  }
}

interface MemoryReviewOwnerAlertTransportDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMilliseconds: number;
}

export interface MemoryReviewOwnerAlertTransport {
  deliver(input: { chatId: string; text: string }): Promise<void>;
}

export function createMemoryReviewOwnerAlertTransport(
  dependencies: MemoryReviewOwnerAlertTransportDependencies,
): MemoryReviewOwnerAlertTransport {
  if (!dependencies.botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  if (!Number.isSafeInteger(dependencies.timeoutMilliseconds) ||
      dependencies.timeoutMilliseconds <= 0) throw new AppError(
    "AGENT_MEMORY_REVIEW_OWNER_ALERT_TIMEOUT_INVALID",
    "Тайм-аут уведомления владельца должен быть положительным целым числом",
  );

  const boundedFetch: typeof fetch = (request, init) => dependencies.fetch(request, {
    ...init,
    signal: AbortSignal.timeout(dependencies.timeoutMilliseconds),
  });
  return {
    async deliver(input): Promise<void> {
      const response = await callTelegramApi({
        body: { chat_id: input.chatId, text: input.text },
        botToken: dependencies.botToken,
        fetch: boundedFetch,
        method: "sendMessage",
      });
      if (!response.ok) throw new MemoryReviewOwnerAlertTransportError(
        "failed",
        "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
        "Telegram отклонил уведомление владельца о сбое проверки памяти",
      );
    },
  };
}

function productionTransport(): MemoryReviewOwnerAlertTransport {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  return createMemoryReviewOwnerAlertTransport({
    botToken,
    fetch,
    timeoutMilliseconds: TELEGRAM_API_REQUEST_TIMEOUT_MS,
  });
}

// Runtime secrets stay lazy so Eve discovery and build remain deterministic.
export const memoryReviewOwnerAlertTransport: MemoryReviewOwnerAlertTransport = {
  async deliver(input) {
    const owner = await database().query<{ telegram_user_id: string }>(`SELECT u.telegram_user_id
      FROM users u JOIN family_memberships m ON m.user_id=u.id WHERE m.role='owner'`);
    if (owner.rows.length !== 1 || owner.rows[0]!.telegram_user_id !== input.chatId) {
      throw new AppError("AGENT_INCIDENT_RECIPIENT_REJECTED", "Получатель служебного уведомления больше не является владельцем");
    }
    await productionTransport().deliver(input);
  },
};
