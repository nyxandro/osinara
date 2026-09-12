/**
 * One-shot owner-private delivery for severe memory-review failures.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertTransportError`: transport failure classification for callers and tests.
 * - `MemoryReviewOwnerAlertClaim`: exact leased alert contract.
 * - `createMemoryReviewOwnerAlertDispatcher`: deterministic outbox processor.
 * - `dispatchMemoryReviewOwnerAlerts`: production minute dispatcher.
 */
import {
  MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE,
  MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS,
} from "./memory-review-config.js";
import {
  type MemoryReviewOwnerAlertClaim,
  memoryReviewOwnerAlertRepository,
} from "./memory-review-owner-alert-repository.js";
import {
  MemoryReviewOwnerAlertTransportError,
  memoryReviewOwnerAlertTransport,
} from "./memory-review-owner-alert-transport.js";

export { MemoryReviewOwnerAlertTransportError } from "./memory-review-owner-alert-transport.js";
export type { MemoryReviewOwnerAlertClaim } from "./memory-review-owner-alert-repository.js";

interface MemoryReviewOwnerAlertDispatcherDependencies {
  claimPending(input: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<MemoryReviewOwnerAlertClaim[]>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  markDelivered(alert: MemoryReviewOwnerAlertClaim): Promise<void>;
  markFailed(
    alert: MemoryReviewOwnerAlertClaim,
    input: { diagnosticCode: string; status: "ambiguous" | "failed" },
  ): Promise<void>;
}

function alertText(alert: MemoryReviewOwnerAlertClaim): string {
  const groupTitle = alert.groupTitle.replace(/\s+/gu, " ").trim();
  if (alert.diagnosticCode === "AGENT_MEMORY_REVIEW_WAITING_MODEL") return [
    "AGENT_MEMORY_REVIEW_WAITING_MODEL",
    `Модель временно не отвечает. Проверка памяти группы «${groupTitle}» ожидает восстановления.`,
    `Сообщения ${alert.fromSequence}–${alert.throughSequence} сохранены. После успешного обращения к этой модели проверка продолжится автоматически.`,
    "Общение в группе остаётся доступным.",
  ].join("\n\n");
  if (alert.diagnosticCode === "AGENT_MEMORY_REVIEW_PARTIAL_RESULT") return [
    "AGENT_MEMORY_REVIEW_PARTIAL_RESULT",
    `Проверка памяти группы «${groupTitle}» завершилась после частичного сохранения сведений.`,
    `Пакет ${alert.fromSequence}–${alert.throughSequence} не отмечен полностью проверенным. Сведения и исходные сообщения сохранены.`,
    "Для продолжения нужна проверка администратора. Общение в группе остаётся доступным.",
  ].join("\n\n");
  if (alert.diagnosticCode === "AGENT_MEMORY_REVIEW_PASS_SKIPPED") {
    // These sources are released rather than held: the lane had to move on, and no later pass will
    // revisit them. Promising their safe recovery here would be false.
    return [
      "AGENT_MEMORY_REVIEW_PASS_SKIPPED",
      `Осинара оборвала проверку памяти группы «${groupTitle}» на середине.`,
      `Сообщения ${alert.fromSequence}–${alert.throughSequence} остались непроверенными, ` +
        "и автоматически к ним никто не вернётся.",
      "Если в них было важное, скажите об этом в чате, и Осинара запомнит заново.",
    ].join("\n\n");
  }
  return [
    "AGENT_MEMORY_REVIEW_BLOCKED",
    `Осинара остановила автоматическую проверку памяти группы «${groupTitle}».`,
    `Не удалось безопасно завершить пакет сообщений ${alert.fromSequence}–${alert.throughSequence}.`,
    "Возможный повтор после запуска модели отключён, чтобы не создать дубликаты.",
    "Исходные сообщения сохранены для безопасного восстановления.",
  ].join("\n\n");
}

function deliveryFailure(error: unknown) {
  if (error instanceof MemoryReviewOwnerAlertTransportError) {
    return { diagnosticCode: error.code, status: "failed" as const };
  }
  return {
    diagnosticCode: "AGENT_MEMORY_REVIEW_OWNER_ALERT_DELIVERY_AMBIGUOUS",
    status: "ambiguous" as const,
  };
}

export function createMemoryReviewOwnerAlertDispatcher(
  dependencies: MemoryReviewOwnerAlertDispatcherDependencies,
) {
  return async function dispatchMemoryReviewOwnerAlerts(now = new Date()): Promise<number> {
    const alerts = await dependencies.claimPending({
      leaseMilliseconds: MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS,
      limit: MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE,
      now,
    });
    for (const alert of alerts) {
      try {
        await dependencies.deliver({
          chatId: alert.ownerTelegramUserId,
          text: alertText(alert),
        });
        await dependencies.markDelivered(alert);
      } catch (error) {
        const failure = deliveryFailure(error);
        console.error(JSON.stringify({
          alertId: alert.alertId,
          batchId: alert.batchId,
          code: failure.diagnosticCode,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        await dependencies.markFailed(alert, failure);
      }
    }
    return alerts.length;
  };
}

export function dispatchMemoryReviewOwnerAlerts(now = new Date()): Promise<number> {
  return createMemoryReviewOwnerAlertDispatcher({
    claimPending: (input) => memoryReviewOwnerAlertRepository.claimPending(input),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    markDelivered: (alert) => memoryReviewOwnerAlertRepository.markDelivered(alert),
    markFailed: (alert, input) => memoryReviewOwnerAlertRepository.markFailed(alert, input),
  })(now);
}
