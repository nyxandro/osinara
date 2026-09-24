/**
 * Telegram "recording a voice message" status while a voice note is being prepared.
 *
 * Exports:
 * - `VOICE_RECORDING_STATUS_CONFIRM_MS`, `VOICE_RECORDING_STATUS_REFRESH_MS`: repeat schedule.
 * - `createVoiceRecordingStatus`: runs one operation while the chat shows the status.
 * - `withVoiceRecordingStatus`: production instance over Telegram `sendChatAction`.
 *
 * Key constructs:
 * - Telegram keeps a chat action for at most five seconds, so the status is repeated inside that
 *   window for as long as the operation runs, and never after it: a status landing after the voice
 *   note would show "recording" under a voice that has already arrived.
 * - Eve shows its own typing status when the model requests the tool, and it may arrive just after
 *   the first recording status; the early repeat puts "recording" back within a second.
 * - The status is presentation only. A failed status call never fails the voice note; it is
 *   reported once per operation, because every repeat fails for the same reason.
 */
import { sendTelegramChatAction } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";

export const VOICE_RECORDING_STATUS_CONFIRM_MS = 1_000;
export const VOICE_RECORDING_STATUS_REFRESH_MS = 4_000;
// Telegram Bot API action for voice notes; clients render it as "recording a voice message".
const RECORD_VOICE_ACTION = "record_voice";

export interface VoiceRecordingStatusTarget {
  chatId: string;
  messageThreadId?: number;
}

type SendRecordingAction = (target: VoiceRecordingStatusTarget) => Promise<void>;

export function createVoiceRecordingStatus(sendAction: SendRecordingAction) {
  return async function withRecordingStatus<T>(
    target: VoiceRecordingStatusTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    let failureReported = false;
    let inFlight: Promise<void> = Promise.resolve();
    const show = () => {
      inFlight = sendAction(target).catch((error: unknown) => {
        if (failureReported) return;
        failureReported = true;
        console.error(JSON.stringify({
          code: "AGENT_VOICE_RECORDING_STATUS_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
      });
    };
    show();
    let refresh: ReturnType<typeof setInterval> | undefined;
    const confirm = setTimeout(() => {
      show();
      refresh = setInterval(show, VOICE_RECORDING_STATUS_REFRESH_MS);
    }, VOICE_RECORDING_STATUS_CONFIRM_MS);
    try {
      return await operation();
    } finally {
      clearTimeout(confirm);
      clearInterval(refresh);
      await inFlight;
    }
  };
}

export const withVoiceRecordingStatus = createVoiceRecordingStatus(async (target) => {
  const response = await sendTelegramChatAction({
    action: RECORD_VOICE_ACTION,
    chatId: target.chatId,
    fetch: (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    ...(target.messageThreadId === undefined ? {} : { messageThreadId: target.messageThreadId }),
  });
  if (!response.ok) {
    throw new AppError(
      "AGENT_VOICE_RECORDING_STATUS_REJECTED",
      "Telegram не показал статус записи голосового сообщения",
    );
  }
});
