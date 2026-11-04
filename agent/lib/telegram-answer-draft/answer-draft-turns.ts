/**
 * The Telegram turns that show "typing" and the answer as it is written, and the calls they make.
 *
 * Exports:
 * - `answerDrafts`: the presenters of the turns this process runs now.
 * - `showsAnswerDraft`: whether a turn gets one: a live turn of a private chat.
 * - `answerDraftTransport`: the draft and "typing" calls of one turn, in its chat and topic.
 * - `startAnswerDraft`: gives a turn its presenter, if it gets one; true when it has one.
 *
 * Key constructs:
 * - Telegram shows a draft only in a private chat, and only a person waiting for the answer needs
 *   either: a group keeps the "typing" of a tool step, a scheduled run and a wake-up show nothing.
 * - The calls are the presenter's own, outside the channel's handle: a refused one reaches the
 *   presenter, which logs it once per turn instead of at every four-second repeat.
 */
import { sendTelegramChatAction } from "../../runtime/telegram/api.js";
import type { TelegramEventContext, TelegramTurnContext } from "../../runtime/telegram/channel-types.js";

import { TELEGRAM_ANSWER_STREAMING_ENABLED, TELEGRAM_CHAT_ACTION_TIMEOUT_MS } from "../../config.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { AppError } from "../app-error.js";
import { isConversationWakeupTurn } from "../conversation-wakeups/conversation-wakeup-events.js";
import { isChatActionStatusShown } from "../telegram-chat-action-status.js";
import { sendTelegramRichMessageDraft } from "../telegram-rich-messages.js";
import { createAnswerDraftPresenter, createAnswerDraftRegistry, type AnswerDraftTransport } from "./answer-draft-presenter.js";

export const answerDrafts = createAnswerDraftRegistry();

export function showsAnswerDraft(channel: Pick<TelegramEventContext, "telegram">, ctx: TelegramTurnContext): boolean {
  return TELEGRAM_ANSWER_STREAMING_ENABLED && channel.telegram.chatType === "private" &&
    !isScheduledSession(ctx) && !isConversationWakeupTurn(ctx);
}

export function answerDraftTransport(channel: Pick<TelegramEventContext, "telegram">, ctx: TelegramTurnContext): AnswerDraftTransport {
  const { chatId, messageThreadId } = channel.telegram;
  return {
    draft: async (markdown) => await sendTelegramRichMessageDraft({ chatId, chatType: "private", messageThreadId }, ctx.session.turn.id, markdown),
    async typing() {
      const response = await sendTelegramChatAction({
        action: "typing",
        chatId,
        credentials: { botToken: process.env.TELEGRAM_BOT_TOKEN },
        fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_CHAT_ACTION_TIMEOUT_MS) }),
        ...(messageThreadId === undefined ? {} : { messageThreadId }),
      });
      if (!response.ok) {
        throw new AppError("AGENT_TELEGRAM_TYPING_REJECTED", "Telegram не показал, что агент печатает", {
          details: { providerStatus: response.status },
        });
      }
    },
  };
}

export function startAnswerDraft(channel: Pick<TelegramEventContext, "telegram">, ctx: TelegramTurnContext): boolean {
  if (!showsAnswerDraft(channel, ctx)) return false;
  const { chatId, messageThreadId } = channel.telegram;
  answerDrafts.start(ctx.session.turn.id, () => createAnswerDraftPresenter({
    statusBusy: () => isChatActionStatusShown({ chatId, ...(messageThreadId === undefined ? {} : { messageThreadId }) }),
    transport: answerDraftTransport(channel, ctx),
  }));
  return true;
}
