/**
 * Safe two-phase Telegram delivery for software update proposals.
 *
 * Exports:
 * - `createSoftwareUpdateProposalDelivery`: placeholder, exact binding, then actionable edit.
 * - `deliverSoftwareUpdateProposal`: production delivery with PostgreSQL and Telegram adapters.
 */
import { softwareUpdateRepository } from "./repository.js";
import {
  SoftwareUpdateTransportError,
  softwareUpdateTelegramTransport,
} from "./telegram-transport.js";
import type {
  DeliverSoftwareUpdateProposalInput,
  SoftwareUpdateRepository,
  SoftwareUpdateTelegramTransport,
} from "./types.js";

const PREPARING_TEXT = "Подготавливаю безопасное предложение обновления Osinara.";

interface ProposalDeliveryDependencies {
  repository: Pick<
    SoftwareUpdateRepository,
    "bindPendingTelegramMessage" | "markDeliveryFailure"
  >;
  transport: Pick<SoftwareUpdateTelegramTransport, "editProposal" | "sendPlaceholder">;
}

function failure(error: unknown) {
  const ambiguous = !(error instanceof SoftwareUpdateTransportError) ||
    error.delivery === "ambiguous";
  return ambiguous
    ? {
        code: "AGENT_SOFTWARE_UPDATE_DELIVERY_AMBIGUOUS",
        message: "После сетевой ошибки не удалось однозначно определить результат доставки обновления",
        status: "delivery_ambiguous" as const,
      }
    : {
        code: "AGENT_SOFTWARE_UPDATE_DELIVERY_FAILED",
        message: "Telegram отклонил доставку предложения обновления",
        status: "delivery_failed" as const,
      };
}

function proposalText(input: DeliverSoftwareUpdateProposalInput): string {
  return [
    `Доступно обновление Osinara до версии ${input.release.version}.`,
    `Описание релиза: ${input.release.releaseUrl}`,
    "Установить его, когда системный контроллер обновлений будет готов?",
  ].join("\n\n");
}

export function createSoftwareUpdateProposalDelivery(dependencies: ProposalDeliveryDependencies) {
  async function persistFailure(proposalId: string, error: unknown): Promise<void> {
    const state = failure(error);
    console.error(JSON.stringify({
      code: state.code,
      error: error instanceof Error ? error.message : String(error),
      proposalId,
      status: state.status,
    }));
    await dependencies.repository.markDeliveryFailure({ proposalId, ...state });
  }

  return async function deliverProposal(
    input: DeliverSoftwareUpdateProposalInput,
  ): Promise<void> {
    let message: Awaited<ReturnType<SoftwareUpdateTelegramTransport["sendPlaceholder"]>>;
    try {
      // The first network side effect is intentionally non-actionable.
      message = await dependencies.transport.sendPlaceholder({
        chatId: input.owner.telegramUserId,
        text: PREPARING_TEXT,
      });
    } catch (error) {
      await persistFailure(input.proposalId, error);
      return;
    }

    if (
      message.chatId !== input.owner.telegramUserId ||
      message.chatType !== "private"
    ) {
      await persistFailure(input.proposalId, new Error(
        "AGENT_SOFTWARE_UPDATE_TELEGRAM_BINDING_MISMATCH",
      ));
      return;
    }
    const bound = await dependencies.repository.bindPendingTelegramMessage({
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: message.messageId,
      proposalId: input.proposalId,
    });
    if (bound !== "bound") {
      await dependencies.repository.markDeliveryFailure({
        code: "AGENT_SOFTWARE_UPDATE_OWNER_CHANGED",
        message: "Владелец изменился до привязки предложения обновления",
        proposalId: input.proposalId,
        status: "delivery_failed",
      });
      return;
    }

    try {
      // Buttons are revealed only after PostgreSQL has the exact private chat and message binding.
      await dependencies.transport.editProposal({
        chatId: message.chatId,
        messageId: message.messageId,
        replyMarkup: {
          inline_keyboard: [[
            { callback_data: `su:a:${input.callbackToken}`, text: "Обновить" },
            { callback_data: `su:d:${input.callbackToken}`, text: "Не сейчас" },
          ]],
        },
        text: proposalText(input),
      });
    } catch (error) {
      await persistFailure(input.proposalId, error);
    }
  };
}

export const deliverSoftwareUpdateProposal = createSoftwareUpdateProposalDelivery({
  repository: softwareUpdateRepository,
  transport: softwareUpdateTelegramTransport,
});
