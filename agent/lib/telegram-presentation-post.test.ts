/**
 * A presented chunk on the Telegram wire.
 *
 * Constructs covered:
 * - A rich message Telegram refused for good (HTTP 400) was not delivered: with files, it goes once
 *   more with a visible line in place of each file, so a file Telegram cannot take costs no answer.
 * - A failure whose outcome is unknown, and a refusal of a message without files, are never resent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";

const postRich = vi.hoisted(() => vi.fn());
vi.mock("./telegram-rich-messages.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./telegram-rich-messages.js")>(),
  postTelegramRichMessageChunk: postRich,
}));

import { postTelegramPresentationChunk } from "./telegram-presentation-post.js";

const channel = { state: {}, telegram: { chatId: "101" } } as never;
const photo = { bytes: new Uint8Array([1]), fileName: "обложка.jpg", id: "f0", kind: "photo" as const, mediaType: "image/jpeg", sha256: "s0" };
const text = "Рецепт\n\n![](tg://photo?id=f0 \"Обложка\")\n\nШаги.";
const refusal = new AppError("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED", "refused", { details: { providerStatus: 400 } });

describe("presented chunk delivery", () => {
  beforeEach(() => vi.resetAllMocks());

  it("sends a refused message with files once more, a line in place of each file", async () => {
    postRich.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ chatType: "private", messageId: "77" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(postTelegramPresentationChunk({ format: "rich", media: [photo], text }, channel)).resolves.toEqual({ chatType: "private", messageId: "77" });

    expect(postRich).toHaveBeenCalledTimes(2);
    expect(postRich.mock.calls[1]![0]).toBe(
      "Рецепт\n\n⚠️ Не удалось приложить «обложка.jpg»: Telegram не принял файл (AGENT_ANSWER_FILE_REFUSED)\n\nШаги.",
    );
    expect(postRich.mock.calls[1]![4]).toEqual([]);
    expect(String(logged.mock.calls[0]?.[0])).toContain("AGENT_ANSWER_FILES_REFUSED");
    logged.mockRestore();
  });

  it("does not resend a message whose delivery is unknown", async () => {
    const lost = new AppError("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS", "lost");
    postRich.mockRejectedValueOnce(lost);

    await expect(postTelegramPresentationChunk({ format: "rich", media: [photo], text }, channel)).rejects.toBe(lost);
    expect(postRich).toHaveBeenCalledOnce();
  });

  it("does not resend a refused message without files", async () => {
    postRich.mockRejectedValueOnce(refusal);

    await expect(postTelegramPresentationChunk({ format: "rich", media: [], text: "Ответ" }, channel)).rejects.toBe(refusal);
    expect(postRich).toHaveBeenCalledOnce();
  });
});
