/**
 * Telegram presentation for an expired HITL approval prompt.
 *
 * Exports:
 * - `timedOutPromptText`: user-facing replacement body for an unanswered confirmation.
 * - `timedOutPromptEditBody`: exact Telegram `editMessageText` payload for an expired prompt.
 * - `createTimedOutPromptFinalizer`: dependency-injected Telegram message rewrite.
 * - `finalizeTimedOutPrompt`: production finalizer bound to the Telegram Bot API.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { TimedOutApprovalClaim } from "./approval-timeout.js";
import { boundSettledPrompt, settledPromptText } from "./settled-prompt.js";

const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;
const TIMEOUT_RESOLUTION = "Время на подтверждение истекло.\nДействие не выполнено.";

export function timedOutPromptText(promptText: string): string {
  // Запрос закрыт по времени: обещание будущего исполнения снимается вместе с ним.
  const settled = settledPromptText(promptText);
  const promptLimit = TELEGRAM_MESSAGE_MAX_CHARACTERS - TIMEOUT_RESOLUTION.length - 2;
  const prompt = boundSettledPrompt(settled, promptLimit);
  return `${prompt}\n\n${TIMEOUT_RESOLUTION}`;
}

export function timedOutPromptEditBody(claim: TimedOutApprovalClaim): {
  chat_id: string;
  message_id: number;
  reply_markup: { inline_keyboard: never[] };
  text: string;
} {
  return {
    chat_id: claim.telegramChatId,
    message_id: Number(claim.telegramMessageId),
    // An empty keyboard removes buttons that can no longer resolve the settled request.
    reply_markup: { inline_keyboard: [] },
    text: timedOutPromptText(claim.promptText),
  };
}

export function createTimedOutPromptFinalizer(
  editMessage: (body: ReturnType<typeof timedOutPromptEditBody>) => Promise<{ ok: boolean }>,
) {
  return async function finalizePrompt(claim: TimedOutApprovalClaim): Promise<void> {
    const edited = await editMessage(timedOutPromptEditBody(claim));
    if (!edited.ok) {
      throw new AppError(
        "AGENT_APPROVAL_TIMEOUT_PROMPT_EDIT_REJECTED",
        "Telegram не обновил сообщение с истёкшим подтверждением",
      );
    }
  };
}

export const finalizeTimedOutPrompt = createTimedOutPromptFinalizer(async (body) => {
  return await callTelegramApi({
    body,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    fetch: (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    method: "editMessageText",
  });
});
