/**
 * Reply buttons on the messages they go out with: a turn's final answer and a reminder.
 *
 * Exports:
 * - `TurnReplyButtons`: the buttons of a turn's last message and the bookkeeping around it.
 * - `turnReplyButtons`: the buttons the model wrote into its final answer, or null for none.
 * - `reportUndeliveredReplyButtons`: reports buttons written where they cannot go out.
 * - `reminderReplyButtons`: one reminder delivery as a rich message with its buttons, or null.
 *
 * Key constructs:
 * - The buttons ride on the last message of the answer, after every split and aside, written into
 *   it as Telegram markup that carries only the set's token and each button's index.
 * - They go only to the person the turn answers, in a private chat or a family group of the turn:
 *   the target comes from the verified Telegram context, not from the model.
 * - The exact text is recorded before that message is sent, so the caption written after a choice
 *   lands under the same words; the message number is recorded once Telegram confirmed it.
 * - Buttons are presentation of a message that matters more: when their bookkeeping fails, the
 *   answer or the reminder goes out without them and the failure is logged. So it does when
 *   Telegram refuses the message carrying them: a refusal means nothing was delivered, so the same
 *   message goes once more without the buttons, which are discarded. Any other failure of the send
 *   may hide a delivered message and is never sent again.
 */
import { fitsTelegramRichMessage } from "../telegram-rich-markdown.js";
import { isTelegramRichMessageRefusal, type SentTelegramMessage } from "../telegram-rich-messages.js";
import { literalRichParagraphs } from "../telegram-rich-literal.js";
import { newReplyButtonToken, type ReplyButtonRows } from "./reply-button-contract.js";
import { replyButtonMarkup, type ReplyButtonMarkupReading } from "./reply-button-markup.js";
import { replyButtonRepository } from "./reply-button-repository.js";

export interface TurnReplyButtons {
  /** Activates the buttons under the last delivered message, if they went out with it. */
  afterDelivery(sent: readonly { readonly messageId: string }[]): Promise<void>;
  /** Sends the last message with its buttons, or without them when they cannot go out with it. */
  sendLast(
    chunk: { readonly format: "plain" | "rich"; readonly text: string },
    post: (text: string) => Promise<SentTelegramMessage>,
  ): Promise<SentTelegramMessage>;
}

type FoundReplyButtons = Pick<ReplyButtonMarkupReading, "error" | "rows">;
type AuthAttributes = Readonly<Record<string, string | readonly string[]>>;
type ButtonChatType = "group" | "private" | "supergroup";

const BUTTON_CHAT_TYPES: ReadonlySet<string> = new Set<ButtonChatType>(["group", "private", "supergroup"]);
// The only group whose members are trusted with buttons; any other group, known or not, gets none.
const FAMILY_GROUP_TYPE = "family_private";
const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]*$/u;
const REMINDER_HEADER = "**⏰ Напоминание:**";

function logFailure(code: string, error: unknown, context: Record<string, string>): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), ...context }));
}

function isButtonChatType(value: unknown): value is ButtonChatType {
  return typeof value === "string" && BUTTON_CHAT_TYPES.has(value);
}

function buttonTarget(attributes: AuthAttributes | undefined, telegramChatId: string) {
  const chatType = attributes?.telegramChatType;
  const addressee = attributes?.telegramUserId;
  if (
    attributes?.telegramChatId !== telegramChatId ||
    typeof addressee !== "string" || !TELEGRAM_USER_ID_PATTERN.test(addressee) ||
    !isButtonChatType(chatType) ||
    (chatType !== "private" && attributes.groupType !== FAMILY_GROUP_TYPE)
  ) {
    return null;
  }
  return { addresseeTelegramUserId: addressee, telegramChatId, telegramChatType: chatType };
}

export function turnReplyButtons(input: {
  agentSessionId: string;
  agentTurnId: string;
  attributes: AuthAttributes | undefined;
  found: FoundReplyButtons | undefined;
  telegramChatId: string;
}): TurnReplyButtons | null {
  if (input.found === undefined) return null;
  if (input.found.rows === null) {
    logFailure("AGENT_REPLY_BUTTONS_REFUSED", input.found.error, { agentTurnId: input.agentTurnId });
    return null;
  }
  const verifiedTarget = buttonTarget(input.attributes, input.telegramChatId);
  if (verifiedTarget === null) {
    console.error(JSON.stringify({ agentTurnId: input.agentTurnId, code: "AGENT_REPLY_BUTTONS_TARGET_INVALID" }));
    return null;
  }
  const target = verifiedTarget;
  const buttons = input.found.rows;
  let sentWithoutButtons = false;

  /** The text of the last message with its buttons and their staged set, or as it was. */
  async function withButtons(chunk: { readonly format: "plain" | "rich"; readonly text: string }) {
    if (chunk.format !== "rich") {
      // The presentation sends an answer with buttons rich; a plain message cannot carry them.
      console.error(JSON.stringify({ agentTurnId: input.agentTurnId, code: "AGENT_REPLY_BUTTONS_FORMAT_INVALID" }));
      return null;
    }
    // The set's token is not known yet; a fresh one has the same length, so the size is final.
    if (!fitsTelegramRichMessage(`${chunk.text}\n\n${replyButtonMarkup(buttons, newReplyButtonToken())}`)) {
      console.error(JSON.stringify({ agentTurnId: input.agentTurnId, code: "AGENT_REPLY_BUTTONS_TOO_LARGE" }));
      return null;
    }
    try {
      // A replay of the same turn finds its staged set again and keeps its token.
      const set = await replyButtonRepository.stageForTurn({
        ...target,
        agentSessionId: input.agentSessionId,
        agentTurnId: input.agentTurnId,
        buttons,
        messageText: chunk.text,
        token: newReplyButtonToken(),
      });
      return { setId: set.id, text: `${chunk.text}\n\n${replyButtonMarkup(set.buttons, set.token)}` };
    } catch (error) {
      logFailure("AGENT_REPLY_BUTTONS_STAGING_FAILED", error, { agentTurnId: input.agentTurnId });
      return null;
    }
  }

  return {
    async afterDelivery(sent) {
      const last = sent.at(-1);
      if (last === undefined || sentWithoutButtons) return;
      try {
        // By the turn, not by a set this attempt staged: a replay that finds the answer already
        // delivered sends nothing, yet the buttons of the first attempt went out with it.
        await replyButtonRepository.activateForTurn(input.agentTurnId, last.messageId);
      } catch (error) {
        // Unactivated buttons still accept their press; only a later message of the addressee
        // does not remove them.
        logFailure("AGENT_REPLY_BUTTONS_ACTIVATION_FAILED", error, { agentTurnId: input.agentTurnId });
      }
    },
    async sendLast(chunk, post) {
      const attached = await withButtons(chunk);
      if (attached === null) return await post(chunk.text);
      try {
        return await post(attached.text);
      } catch (error) {
        if (!isTelegramRichMessageRefusal(error)) throw error;
        // The transport has just logged Telegram's reason with the refusal.
        console.error(JSON.stringify({ agentTurnId: input.agentTurnId, code: "AGENT_REPLY_BUTTONS_REJECTED" }));
        sentWithoutButtons = true;
        try {
          await replyButtonRepository.discard(attached.setId);
        } catch (discardError) {
          // The set stays staged and is never activated: nobody can tap buttons that were not sent.
          logFailure("AGENT_REPLY_BUTTONS_DISCARD_FAILED", discardError, { setId: attached.setId });
        }
        return await post(chunk.text);
      }
    },
  };
}

/** Buttons in a note written before a tool call: removed from it, reported, never delivered. */
export function reportUndeliveredReplyButtons(
  found: FoundReplyButtons | undefined,
  context: { agentTurnId: string },
): void {
  if (found === undefined) return;
  console.error(JSON.stringify({ agentTurnId: context.agentTurnId, code: "AGENT_REPLY_BUTTONS_OUTSIDE_ANSWER" }));
}

/**
 * A reminder with buttons goes out as a rich message, the only kind that carries them; its text is
 * staged first so a choice can be captioned under it. A group-chat reminder never has any: buttons
 * belong to the trusted zones.
 */
export async function reminderReplyButtons(input: {
  addresseeTelegramUserId: string | null;
  buttons: ReplyButtonRows | null;
  content: string;
  delayedNotice: string | null;
  reminderId: string;
  scope: "family" | "group" | "personal";
  telegramChatId: string;
  telegramChatType: string | null;
}): Promise<{ activate(messageId: string): Promise<void>; discard(): Promise<void>; markdown: string } | null> {
  if (input.buttons === null) return null;
  const chatType = input.telegramChatType;
  if (input.scope === "group" || input.addresseeTelegramUserId === null || !isButtonChatType(chatType)) {
    console.error(JSON.stringify({ code: "AGENT_REMINDER_BUTTONS_TARGET_INVALID", reminderId: input.reminderId }));
    return null;
  }
  const paragraphs = [input.content, input.delayedNotice].filter((part) => part !== null).map(literalRichParagraphs);
  const messageText = [REMINDER_HEADER, ...paragraphs].join("\n\n");
  let set: Awaited<ReturnType<typeof replyButtonRepository.stageForReminder>>;
  try {
    set = await replyButtonRepository.stageForReminder({
      addresseeTelegramUserId: input.addresseeTelegramUserId,
      buttons: input.buttons,
      messageText,
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
    discard: async () => await replyButtonRepository.discard(set.id),
    markdown: `${messageText}\n\n${replyButtonMarkup(set.buttons, set.token)}`,
  };
}
