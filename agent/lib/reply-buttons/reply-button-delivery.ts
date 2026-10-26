/**
 * Reply buttons on the messages they go out with: a turn's final answer and a reminder.
 *
 * Exports:
 * - `ReplyButtonsAttachment`: the keyboard of the last message and the bookkeeping around it.
 * - `stagedReplyButtons`: the attachment for a turn, or null when the turn staged no buttons.
 * - `reminderReplyButtons`: the buttons of one reminder delivery, or null when it carries none.
 *
 * Key constructs:
 * - The buttons ride on the last message of the answer, after every split and aside.
 * - The exact text is recorded before that message is sent, so the caption written after a choice
 *   lands under the same words; the message number is recorded once Telegram confirmed it.
 * - Buttons staged for one chat never go out in another.
 * - Buttons are presentation of a message that matters more: when their bookkeeping fails, the
 *   answer or the reminder goes out without them and the failure is logged.
 */
import type { JsonObject } from "../../runtime/json.js";

import { newReplyButtonToken, replyButtonKeyboard, type ReplyButtonRows } from "./reply-button-contract.js";
import { replyButtonRepository, type ReplyButtonMessageFormat } from "./reply-button-repository.js";

export interface ReplyButtonsAttachment {
  /** Activates the buttons under the last delivered message, if they went out with it. */
  afterDelivery(sent: readonly { readonly messageId: string }[]): Promise<void>;
  /** Records the last message's text and returns its keyboard, or nothing when that failed. */
  prepareLastChunk(chunk: { readonly format: ReplyButtonMessageFormat; readonly text: string }): Promise<JsonObject | undefined>;
}

function logFailure(code: string, error: unknown, context: Record<string, string>): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), ...context }));
}

export async function stagedReplyButtons(input: {
  agentTurnId: string;
  telegramChatId: string;
}): Promise<ReplyButtonsAttachment | null> {
  let set: Awaited<ReturnType<typeof replyButtonRepository.findStagedForTurn>>;
  try {
    set = await replyButtonRepository.findStagedForTurn(input.agentTurnId);
  } catch (error) {
    logFailure("AGENT_REPLY_BUTTONS_UNAVAILABLE", error, { agentTurnId: input.agentTurnId });
    return null;
  }
  if (set === null) return null;
  if (set.telegramChatId !== input.telegramChatId) {
    console.error(JSON.stringify({
      agentTurnId: input.agentTurnId,
      code: "AGENT_REPLY_BUTTONS_TARGET_MISMATCH",
      setId: set.id,
    }));
    return null;
  }
  const staged = set;
  let attached = false;
  return {
    async afterDelivery(sent) {
      const last = sent.at(-1);
      if (!attached || last === undefined) return;
      try {
        await replyButtonRepository.activate(staged.id, last.messageId);
      } catch (error) {
        // Unactivated buttons still accept their press; only a later message of the addressee
        // does not remove them.
        logFailure("AGENT_REPLY_BUTTONS_ACTIVATION_FAILED", error, { setId: staged.id });
      }
    },
    async prepareLastChunk(chunk) {
      try {
        await replyButtonRepository.recordMessageText(staged.id, chunk.text, chunk.format);
      } catch (error) {
        logFailure("AGENT_REPLY_BUTTONS_STAGING_FAILED", error, { setId: staged.id });
        return undefined;
      }
      attached = true;
      return replyButtonKeyboard(staged.token, staged.buttons);
    },
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
    console.error(JSON.stringify({ code: "AGENT_REMINDER_BUTTONS_TARGET_INVALID", reminderId: input.reminderId }));
    return null;
  }
  let set: Awaited<ReturnType<typeof replyButtonRepository.stageForReminder>>;
  try {
    set = await replyButtonRepository.stageForReminder({
      addresseeTelegramUserId: input.addresseeTelegramUserId,
      buttons: input.buttons,
      messageEntities: input.messageEntities,
      messageText: input.messageText,
      reminderId: input.reminderId,
      telegramChatId: input.telegramChatId,
      telegramChatType: chatType,
      token: newReplyButtonToken(),
    });
  } catch (error) {
    logFailure("AGENT_REMINDER_BUTTONS_STAGING_FAILED", error, { reminderId: input.reminderId });
    return null;
  }
  return {
    activate: async (messageId) => await replyButtonRepository.activate(set.id, messageId),
    replyMarkup: replyButtonKeyboard(set.token, set.buttons),
  };
}
