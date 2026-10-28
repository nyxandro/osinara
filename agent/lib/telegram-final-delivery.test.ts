/**
 * Durable Telegram final-delivery crash-window tests.
 *
 * Constructs covered:
 * - A delivered replay returns stored receipts without another native send.
 * - A started/ambiguous replay never invokes Telegram again.
 * - A crash after provider acceptance but before chunk persistence becomes terminal ambiguity.
 * - A chunk carries its files to the sender. An answer that shows files is identified by the text
 *   the model wrote, which a replay repeats exactly, while the files on disk may change meanwhile;
 *   an answer without files keeps the identity it always had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const repository = vi.hoisted(() => ({
  complete: vi.fn(),
  confirmChunk: vi.fn(),
  fail: vi.fn(),
  start: vi.fn(),
}));

vi.mock("./telegram-final-delivery-repository.js", () => ({
  telegramFinalDeliveryRepository: repository,
}));

import { deliverTelegramFinalOutput } from "./telegram-final-delivery.js";

const base = {
  applicationSessionId: "00000000-0000-4000-8000-000000000001",
  deliveryIdentity: { chatId: "101" },
  agentSessionId: "wrun_session_1",
  agentTurnId: "turn-1",
  answer: { files: null, markdown: "Готово", problems: [], source: null },
  replyButtons: false,
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("Telegram final delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns durable receipts on replay without a second send", async () => {
    repository.start.mockResolvedValue({
      messages: [{ chatType: "private", messageId: "501" }],
      status: "delivered",
    });
    const sendChunk = vi.fn();

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk })).resolves.toEqual([
      { chatType: "private", messageId: "501" },
    ]);
    expect(repository.start).toHaveBeenCalledWith({
      applicationSessionId: base.applicationSessionId,
      chunkCount: 1,
      agentSessionId: base.agentSessionId,
      agentTurnId: base.agentTurnId,
      outputHash: hash({
        chunks: [hash(base.answer.markdown)],
        deliveryIdentity: base.deliveryIdentity,
      }),
    });
    expect(sendChunk).not.toHaveBeenCalled();
  });

  it("hands a chunk its files and identifies the answer by the text the model wrote", async () => {
    repository.start.mockResolvedValue({
      deliveryId: "00000000-0000-4000-8000-000000000004",
      deliveryToken: "00000000-0000-4000-8000-000000000005",
      status: "started",
    });
    const sendChunk = vi.fn().mockResolvedValue({ chatType: "private", messageId: "503" });
    const upload = { bytes: Buffer.from("pdf"), fileName: "a.pdf", id: "f0", kind: "document" as const, mediaType: "application/pdf", sha256: "sha-a" };
    const answer = {
      files: { marker: "OSINARAFILEabc", places: new Map([[0, { caption: "", upload }]]) },
      markdown: "Отчёт\n\nOSINARAFILEabcT0E",
      problems: [],
      source: "Отчёт\n\n![](/workspace/personal/a.pdf)",
    };

    await deliverTelegramFinalOutput({ ...base, answer, sendChunk });

    const chunk = { format: "rich", media: [upload], pacing: "immediate", text: "Отчёт\n\n![](tg://document?id=f0)" };
    expect(sendChunk).toHaveBeenCalledWith(chunk, 0, true);
    const chunkHash = hash({ media: ["f0:sha-a"], text: chunk.text });
    expect(repository.start).toHaveBeenCalledWith(expect.objectContaining({
      chunkCount: 1,
      outputHash: hash({ answerSource: hash(answer.source), deliveryIdentity: base.deliveryIdentity }),
    }));
    expect(repository.confirmChunk).toHaveBeenCalledWith(expect.objectContaining({ contentHash: chunkHash }));
  });

  it("does not resend a delivery whose started state is crash-ambiguous", async () => {
    repository.start.mockResolvedValue({
      diagnosticCode: "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      status: "ambiguous",
    });
    const sendChunk = vi.fn();

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk }))
      .rejects.toThrowError(/AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS/u);
    expect(sendChunk).not.toHaveBeenCalled();
  });

  it("marks acceptance-before-receipt-persistence as ambiguous without retrying", async () => {
    repository.start.mockResolvedValue({
      deliveryId: "00000000-0000-4000-8000-000000000002",
      deliveryToken: "00000000-0000-4000-8000-000000000003",
      status: "started",
    });
    repository.confirmChunk.mockRejectedValue(new Error("database disconnected after Telegram accepted"));
    const sendChunk = vi.fn().mockResolvedValue({ chatType: "private", messageId: "502" });

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk }))
      .rejects.toThrowError("database disconnected after Telegram accepted");
    expect(sendChunk).toHaveBeenCalledTimes(1);
    // The only chunk is also the last one, the one that would carry reply buttons.
    expect(sendChunk).toHaveBeenCalledWith(
      { format: "plain", media: [], pacing: "immediate", text: "Готово" },
      0,
      true,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      true,
    );
  });
});
