/**
 * Buttons staged in a turn, attached to that turn's final answer.
 *
 * Exports:
 * - `ReplyButtonsAttachment`: the keyboard of the last message and the two bookkeeping steps around it.
 * - `stagedReplyButtons`: the attachment for a turn, or null when the turn staged no buttons.
 * - `reminderReplyButtons`: the buttons of one reminder delivery, or null when it carries none.
 *
 * Key constructs:
 * - The buttons ride on the last message of the answer, after every split and aside.
 * - The exact text is recorded before that message is sent, so the caption written after a choice
 *   lands under the same words; the message number is recorded once Telegram confirmed it.
 * - Buttons staged for one chat never go out in another.
 */
import type { JsonObject } from "../../runtime/json.js";

import { AppError } from "../app-error.js";
import { newReplyButtonToken, replyButtonKeyboard, type ReplyButtonRows } from "./reply-button-contract.js";
import { replyButtonRepository, type ReplyButtonMessageFormat } from "./reply-button-repository.js";

export interface ReplyButtonsAttachment {
  afterDelivery(sent: readonly { readonly messageId: string }[]): Promise<void>;
  beforeLastChunk(chunk: { readonly format: ReplyButtonMessageFormat; readonly text: string }): Promise<void>;
  readonly replyMarkup: JsonObject;
}

export async function stagedReplyButtons(input: {
  agentTurnId: string;
  telegramChatId: string;
}): Promise<ReplyButtonsAttachment | null> {
  const set = await replyButtonRepository.findStagedForTurn(input.agentTurnId);
  if (set === null) return null;
  if (set.telegramChatId !== input.telegramChatId) {
    throw new AppError(
      "AGENT_REPLY_BUTTONS_TARGET_MISMATCH",
      "Кнопки ответа подготовлены для другого чата и не будут показаны",
    );
  }
  return {
    async afterDelivery(sent) {
      const last = sent.at(-1);
      if (last === undefined) {
        throw new AppError("AGENT_REPLY_BUTTONS_MESSAGE_MISSING", "Telegram не подтвердил сообщение с кнопками ответа");
      }
      try {
        await replyButtonRepository.activate(set.id, last.messageId);
      } catch (error) {
        // The answer is delivered either way. Unactivated buttons still accept their press; only a
        // later message of the addressee does not remove them.
        console.error(JSON.stringify({
          code: "AGENT_REPLY_BUTTONS_ACTIVATION_FAILED",
          error: error instanceof Error ? error.message : String(error),
          setId: set.id,
        }));
      }
    },
    async beforeLastChunk(chunk) {
      await replyButtonRepository.recordMessageText(set.id, chunk.text, chunk.format);
    },
    replyMarkup: replyButtonKeyboard(set.token, set.buttons),
  };
}

/**
 * A reminder's buttons for one delivery, staged with the exact text and entities it goes out with.
 * A group-chat reminder never has any: buttons belong to the trusted zones.
 */
export async function reminderReplyButtons(input: {
  addresseeTelegramUserId: string | null;
  buttons: ReplyButtonRows | null;
  messageEntities: readonly JsonObject[];
  messageText: string;
  reminderId: string;
  scope: "family" | "group" | "personal";
  telegramChatId: string;
  telegramChatType: string | null;
}): Promise<{ activate(messageId: string): Promise<void>; replyMarkup: JsonObject } | null> {
  if (input.buttons === null) return null;
  const chatType = input.telegramChatType;
  if (
    input.scope === "group" ||
    input.addresseeTelegramUserId === null ||
    (chatType !== "private" && chatType !== "group" && chatType !== "supergroup")
  ) {
    throw new AppError(
      "AGENT_REMINDER_BUTTONS_TARGET_INVALID",
      "Не удалось определить, кому адресованы кнопки напоминания",
    );
  }
  const set = await replyButtonRepository.stageForReminder({
    addresseeTelegramUserId: input.addresseeTelegramUserId,
    buttons: input.buttons,
    messageEntities: input.messageEntities,
    messageText: input.messageText,
    reminderId: input.reminderId,
    telegramChatId: input.telegramChatId,
    telegramChatType: chatType,
    token: newReplyButtonToken(),
  });
  return {
    activate: async (messageId) => await replyButtonRepository.activate(set.id, messageId),
    replyMarkup: replyButtonKeyboard(set.token, set.buttons),
  };
}
