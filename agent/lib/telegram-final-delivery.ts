/**
 * Crash-safe orchestration for one native Telegram final message.
 *
 * Exports:
 * - `deliverTelegramFinalOutput`: sends plain or rich chunks once behind the durable outbox barrier.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import {
  formatTelegramFinalPresentation,
  type TelegramFinalPresentationChunk,
} from "./telegram-final-presentation.js";
import type { SentTelegramMessage } from "./telegram-rich-messages.js";
import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";
import { formatTelegramRichMessages } from "./telegram-rich-markdown.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  markdown: string;
  sendChunk(chunk: TelegramFinalPresentationChunk, ordinal: number): Promise<SentTelegramMessage>;
}): Promise<SentTelegramMessage[]> {
  const chunks = formatTelegramFinalPresentation(input.markdown);
  const legacyChunks = formatTelegramRichMessages(input.markdown);
  const outputHash = hash({
    chunks: chunks.map((chunk) => hash(chunk.text)),
    deliveryIdentity: input.deliveryIdentity,
  });
  const start = await telegramFinalDeliveryRepository.start({
    applicationSessionId: input.applicationSessionId,
    chunkCount: chunks.length,
    agentSessionId: input.agentSessionId,
    agentTurnId: input.agentTurnId,
    legacyChunkCount: legacyChunks.length,
    legacyOutputHash: hash({
      chunks: legacyChunks.map((chunk) => hash(chunk)),
      deliveryIdentity: input.deliveryIdentity,
    }),
    outputHash,
  });
  if (start.status === "delivered") return start.messages;
  if (start.status !== "started") throw terminalDeliveryError(start.diagnosticCode);

  const sent: SentTelegramMessage[] = [];
  try {
    for (const [ordinal, chunk] of chunks.entries()) {
      const message = await input.sendChunk(chunk, ordinal);
      await telegramFinalDeliveryRepository.confirmChunk({
        chatType: message.chatType,
        contentHash: hash(chunk.text),
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
