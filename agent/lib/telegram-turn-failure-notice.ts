/**
 * The person's word in the chat that their message got no answer (#561).
 *
 * Export:
 * - `noticeFailedTurn`: sends the notice once to the chat the person wrote in, or nothing.
 *
 * Before this, a person whose turn failed — six of nine failures in thirty days were the model being out of
 * reach — got nothing, while the owner got a failure notice. The notice goes only for a turn a person's
 * Telegram message started: a scenario, a wake-up and a background task's event have their own ends, and a
 * turn closed for lost access must not speak. The owner's own private chat gets none either: the owner's
 * failure notice already says it there. It travels as the turn's final message, through the outbox, so a
 * replayed failure never sends it twice and a turn whose answer had started going gets none.
 */
import type { TelegramEventContext, TelegramTurnContext } from "../runtime/telegram/channel-types.js";

import { deliverTelegramFinalOutput } from "./telegram-final-delivery.js";
import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";
import { postTelegramPresentationChunk } from "./telegram-presentation-post.js";
import { telegramTurnReplyParameters } from "./telegram-reply.js";

const ACCESS_REVOKED = "AGENT_TURN_ACCESS_REVOKED";

function noticeText(code: string): string {
  return `Не получилось ответить на это сообщение: сбой на моей стороне. Попробуйте написать ещё раз чуть позже. Код: ${code}`;
}

function wanted(ctx: TelegramTurnContext, code: string): boolean {
  const attributes = ctx.session.auth.current?.attributes;
  if (typeof attributes?.osinaraTelegramUpdateId !== "string" || code === ACCESS_REVOKED) return false;
  return !(attributes.role === "owner" && attributes.telegramChatType === "private");
}

export async function noticeFailedTurn(input: {
  readonly applicationSessionId: string;
  readonly channel: TelegramEventContext;
  readonly code: string;
  readonly ctx: TelegramTurnContext;
}): Promise<void> {
  if (!wanted(input.ctx, input.code)) return;
  const text = noticeText(input.code);
  try {
    // A turn whose own answer began going out (and failed on the way) gets no second message.
    if (await telegramFinalDeliveryRepository.hasDelivery(input.ctx.session.turn.id)) return;
    const replyParameters = telegramTurnReplyParameters(input.channel.state, input.ctx);
    await deliverTelegramFinalOutput({
      agentSessionId: input.ctx.session.id,
      agentTurnId: input.ctx.session.turn.id,
      answer: { files: null, markdown: text, problems: [], source: null },
      applicationSessionId: input.applicationSessionId,
      deliveryIdentity: { failureNotice: input.code, replyParameters: replyParameters ?? null },
      replyButtons: false,
      sendChunk: async (chunk, ordinal) => await postTelegramPresentationChunk(
        chunk, input.channel, ordinal === 0 ? replyParameters : undefined,
      ),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TURN_FAILURE_NOTICE_FAILED",
      error: error instanceof Error ? error.message : String(error),
      failureCode: input.code,
      turnId: input.ctx.session.turn.id,
    }));
  }
}
