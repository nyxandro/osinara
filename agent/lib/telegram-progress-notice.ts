/**
 * Interim Telegram progress notice for a long interactive turn.
 *
 * Export:
 * - `deliverTelegramProgressNotice`: sends model-authored pre-tool text at most once per step.
 *
 * Key constructs:
 * - The notice is cosmetic and its turn is still working, so a failed send is logged and the turn
 *   continues; the durable claim happens first, so a replay never repeats a delivered notice.
 * - It is presented exactly like a final answer: markup goes out as a rich message, plain text as an
 *   ordinary one. Asides are not paced: the turn is still working and must not wait on a notice.
 */
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { isAppError } from "./app-error.js";
import { formatTelegramFinalPresentation } from "./telegram-final-presentation.js";
import { postTelegramPresentationChunk } from "./telegram-presentation-post.js";
import { telegramProgressNoticeRepository } from "./telegram-progress-notice-repository.js";

export async function deliverTelegramProgressNotice(input: {
  applicationSessionId: string;
  channel: TelegramEventContext;
  agentSessionId: string;
  agentTurnId: string;
  message: string;
  stepIndex: number;
}): Promise<void> {
  const claim = await telegramProgressNoticeRepository.claim({
    applicationSessionId: input.applicationSessionId,
    agentSessionId: input.agentSessionId,
    agentTurnId: input.agentTurnId,
    stepIndex: input.stepIndex,
  });
  if (!claim) return;

  try {
    let firstMessageId: string | null = null;
    for (const chunk of formatTelegramFinalPresentation(input.message)) {
      const sent = await postTelegramPresentationChunk(chunk, input.channel);
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
