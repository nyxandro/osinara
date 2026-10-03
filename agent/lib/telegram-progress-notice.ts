/**
 * Interim Telegram progress notice for a long interactive turn.
 *
 * Export:
 * - `deliverTelegramProgressNotice`: sends model-authored pre-tool text at most once per step.
 *
 * Key construct:
 * - The notice is cosmetic and its turn is still working, so a failed send is logged and the turn
 *   continues; the durable claim happens first, so a replay never repeats a delivered notice.
 */
import { splitTelegramMessageText } from "../runtime/telegram/api.js";
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { isAppError } from "./app-error.js";
import { postTelegramPlainMessageChunk } from "./telegram-plain-messages.js";
import { telegramProgressNoticeRepository } from "./telegram-progress-notice-repository.js";

export async function deliverTelegramProgressNotice(input: {
  applicationSessionId: string;
  channel: TelegramEventContext;
  eveSessionId: string;
  eveTurnId: string;
  message: string;
  stepIndex: number;
}): Promise<void> {
  const claim = await telegramProgressNoticeRepository.claim({
    applicationSessionId: input.applicationSessionId,
    eveSessionId: input.eveSessionId,
    eveTurnId: input.eveTurnId,
    stepIndex: input.stepIndex,
  });
  if (!claim) return;

  try {
    let firstMessageId: string | null = null;
    for (const chunk of splitTelegramMessageText(input.message)) {
      const sent = await postTelegramPlainMessageChunk(chunk, input.channel);
      firstMessageId ??= sent.messageId;
    }
    if (firstMessageId !== null) {
      await telegramProgressNoticeRepository.confirm(claim.noticeId, firstMessageId);
    }
  } catch (error) {
    // The answer this notice announces is still being produced: never fail the turn over a notice.
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_PROGRESS_NOTICE_FAILED",
      errorCode: isAppError(error) ? error.code : null,
      errorName: error instanceof Error ? error.name : "UnknownError",
      stepIndex: input.stepIndex,
    }));
  }
}
