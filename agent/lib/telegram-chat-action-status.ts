/**
 * A Telegram chat status ("recording a voice message", "choosing a sticker") held for one operation.
 *
 * Exports:
 * - `CHAT_ACTION_STATUS_CONFIRM_MS`, `CHAT_ACTION_STATUS_REFRESH_MS`: repeat schedule.
 * - `ChatActionStatusTarget`, `ChatActionStatus`: the chat a status is shown in and its runner.
 * - `createChatActionStatus`: runs one operation while the chat shows the status.
 * - `telegramChatActionStatus`: production instance over Telegram `sendChatAction`.
 *
 * Key constructs:
 * - Telegram keeps a chat action for at most five seconds, so the status is repeated inside that
 *   window for as long as the operation runs, and never after it: a status landing after the result
 *   would show "recording" under a voice note that has already arrived.
 * - The runtime shows a typing status when the model requests the tool, and it may arrive just after
 *   the first status; the early repeat puts the right status back within a second.
 * - The status is presentation only. A failed status call never fails the operation; it is
 *   reported once per operation under the caller's code, because every repeat fails for the same
 *   reason. Each call has a short timeout of its own, since the operation waits for every call still
 *   in flight.
 */
import { sendTelegramChatAction } from "../runtime/telegram/api.js";

import { AppError, isAppError } from "./app-error.js";
import { TELEGRAM_CHAT_ACTION_TIMEOUT_MS } from "../config.js";

export const CHAT_ACTION_STATUS_CONFIRM_MS = 1_000;
export const CHAT_ACTION_STATUS_REFRESH_MS = 4_000;

/** Telegram Bot API actions in use; clients render them as "recording a voice message" and "choosing a sticker". */
type TelegramChatAction = "choose_sticker" | "record_voice";

export interface ChatActionStatusTarget {
  chatId: string;
  messageThreadId?: number;
}

export type ChatActionStatus = <T>(target: ChatActionStatusTarget, operation: () => Promise<T>) => Promise<T>;

type SendChatAction = (target: ChatActionStatusTarget) => Promise<void>;

class ChatActionRejected extends AppError {
  constructor(readonly providerStatus: number) {
    super("AGENT_TELEGRAM_CHAT_ACTION_REJECTED", "Telegram не показал статус действия в чате");
  }
}

export function createChatActionStatus(sendAction: SendChatAction, failureCode: string): ChatActionStatus {
  return async function withChatActionStatus<T>(
    target: ChatActionStatusTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    let failureReported = false;
    const inFlight = new Set<Promise<void>>();
    const show = () => {
      const request = sendAction(target).catch((error: unknown) => {
        if (failureReported) return;
        failureReported = true;
        console.error(JSON.stringify({
          code: failureCode,
          errorCode: isAppError(error) ? error.code : undefined,
          errorName: error instanceof Error ? error.name : "UnknownError",
          providerStatus: error instanceof ChatActionRejected ? error.providerStatus : undefined,
        }));
      }).finally(() => inFlight.delete(request));
      inFlight.add(request);
    };
    show();
    let refresh: ReturnType<typeof setInterval> | undefined;
    const confirm = setTimeout(() => {
      show();
      refresh = setInterval(show, CHAT_ACTION_STATUS_REFRESH_MS);
    }, CHAT_ACTION_STATUS_CONFIRM_MS);
    try {
      return await operation();
    } finally {
      clearTimeout(confirm);
      clearInterval(refresh);
      await Promise.all(inFlight);
    }
  };
}

export function telegramChatActionStatus(input: {
  action: TelegramChatAction;
  failureCode: string;
}): ChatActionStatus {
  return createChatActionStatus(async (target) => {
    const response = await sendTelegramChatAction({
      action: input.action,
      chatId: target.chatId,
      credentials: { botToken: process.env.TELEGRAM_BOT_TOKEN },
      fetch: (request, init) =>
        fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_CHAT_ACTION_TIMEOUT_MS) }),
      ...(target.messageThreadId === undefined ? {} : { messageThreadId: target.messageThreadId }),
    });
    if (!response.ok) throw new ChatActionRejected(response.status);
  }, input.failureCode);
}
