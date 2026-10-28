/**
 * Interim Telegram progress notice for a long interactive turn.
 *
 * Export:
 * - `deliverTelegramProgressNotice`: sends model-authored pre-tool text at most once per step.
 *
 * Key constructs:
 * - The notice is cosmetic and its turn is still working, so a failed send is logged and the turn
 *   continues; the durable claim happens first, so a replay never repeats a delivered notice.
 * - It goes exactly like a final answer: markup as a rich message, plain text as an ordinary one,
 *   and a workspace file it shows inside it, read with the chat's rights. A file that cannot go
 *   leaves a visible line; only a final answer goes back to the model for a fix. Asides are not
 *   paced: the turn is still working and must not wait on a notice.
 */
import type { SessionAuth } from "../runtime/context.js";
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { presentTelegramAnswer } from "./answer-files/answer-file-delivery.js";
import { prepareTelegramAnswerFiles } from "./answer-files/telegram-answer-files.js";
import { isAppError } from "./app-error.js";
import { postTelegramPresentationChunk } from "./telegram-presentation-post.js";
import { telegramProgressNoticeRepository } from "./telegram-progress-notice-repository.js";

export async function deliverTelegramProgressNotice(input: {
  applicationSessionId: string;
  channel: TelegramEventContext;
  agentSessionId: string;
  agentTurnId: string;
  message: string;
  /** The verified session of the turn: a file the notice shows is read with its rights. */
  session: { readonly auth: SessionAuth };
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
    const notice = await prepareTelegramAnswerFiles({
      agentTurnId: input.agentTurnId,
      markdown: input.message,
      session: input.session,
    });
    for (const chunk of presentTelegramAnswer(notice, { replyButtons: false })) {
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
