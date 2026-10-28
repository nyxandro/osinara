/**
 * Crash-safe orchestration for one native Telegram final message.
 *
 * Exports:
 * - `deliverTelegramFinalOutput`: sends plain or rich chunks once behind the durable outbox barrier.
 *
 * Key construct:
 * - An answer without files is identified by its chunks, as before files existed, so a delivery
 *   started by an older release still matches. An answer that shows files is identified by the text
 *   the model wrote: a replay repeats it exactly, while a file on disk may have changed or gone, and
 *   a delivered answer must then still be recognized instead of failing the turn.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import {
  presentTelegramAnswer,
  type PreparedTelegramAnswer,
  type TelegramAnswerChunk,
} from "./answer-files/answer-file-delivery.js";
import type { SentTelegramMessage } from "./telegram-rich-messages.js";
import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function chunkHash(chunk: TelegramAnswerChunk): string {
  return chunk.media.length === 0
    ? hash(chunk.text)
    : hash({ media: chunk.media.map((upload) => `${upload.id}:${upload.sha256}`), text: chunk.text });
}

function terminalDeliveryError(code: string): AppError {
  return new AppError(
    code,
    "Доставка ответа Telegram уже начиналась и не будет повторена автоматически",
  );
}

export async function deliverTelegramFinalOutput(input: {
  applicationSessionId: string;
  deliveryIdentity: unknown;
  agentSessionId: string;
  agentTurnId: string;
  /** The answer text with its files laid out (`prepareAnswerFiles`). */
  answer: PreparedTelegramAnswer;
  /** The answer carries reply buttons: its last message is rich, the only kind that holds them. */
  replyButtons: boolean;
  /** `last` marks the final message of the answer, the one that carries reply buttons. */
  sendChunk(chunk: TelegramAnswerChunk, ordinal: number, last: boolean): Promise<SentTelegramMessage>;
}): Promise<SentTelegramMessage[]> {
  const chunks = presentTelegramAnswer(input.answer, { replyButtons: input.replyButtons });
  const outputHash = input.answer.source === null
    ? hash({ chunks: chunks.map(chunkHash), deliveryIdentity: input.deliveryIdentity })
    : hash({ answerSource: hash(input.answer.source), deliveryIdentity: input.deliveryIdentity });
  const start = await telegramFinalDeliveryRepository.start({
    applicationSessionId: input.applicationSessionId,
    chunkCount: chunks.length,
    agentSessionId: input.agentSessionId,
    agentTurnId: input.agentTurnId,
    outputHash,
  });
  if (start.status === "delivered") return start.messages;
  if (start.status !== "started") throw terminalDeliveryError(start.diagnosticCode);

  const sent: SentTelegramMessage[] = [];
  try {
    for (const [ordinal, chunk] of chunks.entries()) {
      const message = await input.sendChunk(chunk, ordinal, ordinal === chunks.length - 1);
      await telegramFinalDeliveryRepository.confirmChunk({
        chatType: message.chatType,
        contentHash: chunkHash(chunk),
        deliveryId: start.deliveryId,
        deliveryToken: start.deliveryToken,
        messageId: message.messageId,
        ordinal,
      });
      sent.push(message);
    }
    await telegramFinalDeliveryRepository.complete(start.deliveryId, start.deliveryToken);
    return sent;
  } catch (error) {
    const definitive = error instanceof AppError && error.code.endsWith("_DELIVERY_FAILED");
    await telegramFinalDeliveryRepository.fail(
      start.deliveryId,
      start.deliveryToken,
      definitive
        ? "AGENT_TELEGRAM_FINAL_DELIVERY_FAILED"
        : "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      !definitive,
    );
    throw error;
  }
}
