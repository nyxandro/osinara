/**
 * Native Telegram Rich Message delivery tests.
 *
 * Constructs covered:
 * - An answer's draft is one per private chat/topic and agent turn, refused before delivery without
 *   a turn; a refusal comes back with Telegram's wait, unlogged.
 * - Completed output is persisted with sendRichMessage and anchors group conversations.
 * - The first chunk of a group response replies to the verified triggering message.
 * - Telegram rejection and ambiguous transport failures remain fail-fast without retries.
 * - A refusal of the message itself (HTTP 400) is told apart from every other failure and carries
 *   Telegram's own reason for the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isTelegramRichMessageRefusal,
  postTelegramRichMessage,
  postTelegramRichMessageChunk,
  sendTelegramRichMessageDraft,
} from "./telegram-rich-messages.js";

beforeEach(() => vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function telegramTarget(
  overrides: Partial<{
    chatId: string;
    chatType: "group" | "private" | "supergroup";
    messageThreadId: number;
  }> = {},
) {
  return {
    chatId: overrides.chatId ?? "123456789",
    chatType: overrides.chatType ?? "private",
    messageThreadId: overrides.messageThreadId,
  };
}

function telegramResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.spyOn>, index = 0) {
  return JSON.parse(String(fetchMock.mock.calls[index]![1]?.body)) as Record<
    string,
    unknown
  >;
}

describe("Telegram rich answer drafts", () => {
  it("shows the answer written so far as a draft in a private chat and its topic", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse(true));

    await expect(sendTelegramRichMessageDraft(telegramTarget({ messageThreadId: 42 }), "turn_1", "Пишу **ответ**"))
      .resolves.toEqual({ ok: true });

    expect(String(telegramFetch.mock.calls[0]![0])).toBe("https://api.telegram.org/bottelegram-bot-secret/sendRichMessageDraft");
    expect(requestBody(telegramFetch)).toEqual({
      chat_id: 123456789,
      draft_id: expect.any(Number),
      message_thread_id: 42,
      rich_message: { markdown: "Пишу **ответ**" },
    });
  });

  it("keeps one draft per turn and topic, so the updates of an answer replace each other", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => telegramResponse(true));

    await sendTelegramRichMessageDraft(telegramTarget(), "turn_24", "А");
    await sendTelegramRichMessageDraft(telegramTarget(), "turn_24", "Аб");
    await sendTelegramRichMessageDraft(telegramTarget(), "turn_25", "В");
    await sendTelegramRichMessageDraft(telegramTarget({ messageThreadId: 7 }), "turn_24", "Г");

    const ids = [0, 1, 2, 3].map((index) => requestBody(telegramFetch, index).draft_id);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => Number.isInteger(id) && (id as number) > 0)).toBe(true);
  });

  it("does not show a draft outside a private chat or without a turn", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse(true));

    await expect(sendTelegramRichMessageDraft(telegramTarget({ chatId: "-100123", chatType: "supergroup" }), "turn_1", "Текст"))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_DRAFT_TARGET_INVALID" });
    await expect(sendTelegramRichMessageDraft(telegramTarget(), "", "Текст"))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_RICH_TURN_ID_INVALID" });
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("returns a refusal with Telegram's wait, once, without logging or retrying it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ description: "Too Many Requests: retry after 5", ok: false, parameters: { retry_after: 5 } }),
      { headers: { "content-type": "application/json" }, status: 429 },
    ));

    await expect(sendTelegramRichMessageDraft(telegramTarget(), "turn_1", "Текст")).resolves.toEqual({
      description: "Too Many Requests: retry after 5",
      ok: false,
      providerStatus: 429,
      retryAfterSeconds: 5,
    });
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("postTelegramRichMessage", () => {
  it("persists completed Rich Markdown and records the returned group anchor", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      telegramResponse({
        chat: { id: -100123, type: "supergroup" },
        message_id: 73,
      }),
    );
    const state = {
      chatType: "supergroup" as const,
      conversationId: "55" as string | null,
    };

    await postTelegramRichMessage(
      "## Итог\n\n| Шаг | Статус |\n| --- | --- |\n| 1 | Готово |",
      telegramTarget({
        chatId: "-100123",
        chatType: "supergroup",
        messageThreadId: 7,
      }),
      state,
    );

    expect(String(telegramFetch.mock.calls[0]![0])).toBe(
      "https://api.telegram.org/bottelegram-bot-secret/sendRichMessage",
    );
    expect(requestBody(telegramFetch)).toMatchObject({
      chat_id: -100123,
      message_thread_id: 7,
      rich_message: { markdown: expect.stringContaining("| Шаг | Статус |") },
    });
    expect(state.conversationId).toBe("73");
  });

  it("replies only the first group chunk to the triggering user message", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        telegramResponse({ chat: { type: "supergroup" }, message_id: 73 }),
      );

    await postTelegramRichMessage(
      Array.from(
        { length: 300 },
        (_, index) => `Абзац ${index}: ${"длинный текст ".repeat(20)}`,
      ).join("\n\n"),
      telegramTarget({ chatId: "-100123", chatType: "supergroup" }),
      undefined,
      { allow_sending_without_reply: true, message_id: 55 },
    );

    expect(telegramFetch.mock.calls.length).toBeGreaterThan(1);
    expect(requestBody(telegramFetch, 0)).toMatchObject({
      reply_parameters: { allow_sending_without_reply: true, message_id: 55 },
    });
    expect(requestBody(telegramFetch, 1)).not.toHaveProperty(
      "reply_parameters",
    );
  });

  it("uploads the files of a chunk with it in one multipart request", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      telegramResponse({ chat: { type: "private" }, message_id: 90 }),
    );
    const markdown = "Текст\n\n![](tg://photo?id=f0 \"Обложка\")\n\n![](tg://document?id=f1)";

    const sent = await postTelegramRichMessageChunk(
      markdown,
      telegramTarget({ messageThreadId: 7 }),
      undefined,
      { allow_sending_without_reply: true, message_id: 5 },
      [
        { bytes: new Uint8Array([1, 2, 3]), fileName: "d.jpg", id: "f0", kind: "photo", mediaType: "image/jpeg", sha256: "s0" },
        { bytes: new Uint8Array([4]), fileName: "Отчёт.pdf", id: "f1", kind: "document", mediaType: "application/pdf", sha256: "s1" },
      ],
    );

    expect(sent).toEqual({ chatType: "private", messageId: "90" });
    expect(String(telegramFetch.mock.calls[0]![0])).toBe("https://api.telegram.org/bottelegram-bot-secret/sendRichMessage");
    const init = telegramFetch.mock.calls[0]![1]!;
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("123456789");
    expect(form.get("message_thread_id")).toBe("7");
    expect(JSON.parse(String(form.get("reply_parameters")))).toEqual({ allow_sending_without_reply: true, message_id: 5 });
    expect(JSON.parse(String(form.get("rich_message")))).toEqual({
      markdown,
      media: [
        { id: "f0", media: { media: "attach://f0", type: "photo" } },
        { id: "f1", media: { media: "attach://f1", type: "document" } },
      ],
    });
    const photo = form.get("f0") as File;
    expect([photo.name, photo.type, [...new Uint8Array(await photo.arrayBuffer())]]).toEqual(["d.jpg", "image/jpeg", [1, 2, 3]]);
    expect((form.get("f1") as File).name).toBe("Отчёт.pdf");
  });

  it("learns which Telegram file each media block of the chunk became", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse({
      chat: { type: "private" },
      message_id: 91,
      rich_message: { blocks: [
        { text: "Текст", type: "paragraph" },
        { photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }], type: "photo" },
        { blocks: [{ document: { file_id: "document-1" }, type: "document" }], type: "details" },
        { photo: [{ file_id: "photo-again" }], type: "photo" },
      ] },
    }));
    const markdown = "Текст\n\n![](tg://photo?id=f0 \"Обложка\")\n\n<details><summary>Полный ответ</summary>\n\n![](tg://document?id=f1)\n\n</details>\n\n![](tg://photo?id=f0)";
    const media = [
      { bytes: new Uint8Array([1]), fileName: "d.jpg", id: "f0", kind: "photo" as const, mediaType: "image/jpeg", sha256: "s0" },
      { bytes: new Uint8Array([2]), fileName: "a.pdf", id: "f1", kind: "document" as const, mediaType: "application/pdf", sha256: "s1" },
    ];

    const sent = await postTelegramRichMessageChunk(markdown, telegramTarget(), undefined, undefined, media);

    expect(sent).toEqual({
      chatType: "private",
      media: [{ fileId: "photo-large", id: "f0", kind: "photo" }, { fileId: "document-1", id: "f1", kind: "document" }],
      messageId: "91",
    });
  });

  it("learns the file of a voice note Telegram returns for an audio block (#480)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse({
      chat: { type: "private" },
      message_id: 94,
      rich_message: { blocks: [{ type: "paragraph" }, { type: "voice_note", voice_note: { file_id: "voice-1" } }] },
    }));

    const sent = await postTelegramRichMessageChunk("Задачи на сегодня\n\n![](tg://audio?id=f0)", telegramTarget(), undefined, undefined, [
      { bytes: new Uint8Array([1]), fileName: "tasks.ogg", id: "f0", kind: "audio", mediaType: "audio/ogg; codecs=opus", sha256: "s0" },
    ]);

    expect(sent.media).toEqual([{ fileId: "voice-1", id: "f0", kind: "audio" }]);
  });

  it("does not take a media-like line the model showed as code for a block", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse({
      chat: { type: "private" },
      message_id: 93,
      rich_message: { blocks: [{ type: "pre" }, { photo: [{ file_id: "photo-1" }], type: "photo" }] },
    }));

    const sent = await postTelegramRichMessageChunk("```\n![](tg://photo?id=f0)\n```\n\n![](tg://photo?id=f0)", telegramTarget(), undefined, undefined, [
      { bytes: new Uint8Array([1]), fileName: "d.jpg", id: "f0", kind: "photo", mediaType: "image/jpeg", sha256: "s0" },
    ]);

    expect(sent.media).toEqual([{ fileId: "photo-1", id: "f0", kind: "photo" }]);
  });

  it("keeps a sent chunk whose returned media do not match its blocks, without their files", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(telegramResponse({
      chat: { type: "private" },
      message_id: 92,
      rich_message: { blocks: [{ document: { file_id: "document-1" }, type: "document" }] },
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const sent = await postTelegramRichMessageChunk("![](tg://photo?id=f0)", telegramTarget(), undefined, undefined, [
      { bytes: new Uint8Array([1]), fileName: "d.jpg", id: "f0", kind: "photo", mediaType: "image/jpeg", sha256: "s0" },
    ]);

    expect(sent).toEqual({ chatType: "private", messageId: "92" });
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("AGENT_TELEGRAM_RICH_MEDIA_RECEIPT_MISMATCH");
  });

  it("does not retry an ambiguously failed final delivery", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(timeout);

    await expect(
      postTelegramRichMessage("Ответ", telegramTarget()),
    ).rejects.toBe(timeout);

    expect(timeout.message).toContain(
      "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
    );
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("tells a refusal of the message from any other failure, with Telegram's reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = (status: number, description: string) => new Response(
      JSON.stringify({ description, error_code: status, ok: false }),
      { headers: { "content-type": "application/json" }, status },
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(failure(400, "Bad Request: BUTTON_TEXT_INVALID"))
      .mockResolvedValueOnce(failure(429, "Too Many Requests: retry after 3"))
      .mockResolvedValueOnce(failure(502, "Bad Gateway"));

    const refused = await postTelegramRichMessageChunk("Ответ", telegramTarget()).catch((error: unknown) => error);
    const limited = await postTelegramRichMessageChunk("Ответ", telegramTarget()).catch((error: unknown) => error);
    const broken = await postTelegramRichMessageChunk("Ответ", telegramTarget()).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED",
      details: { description: "Bad Request: BUTTON_TEXT_INVALID", providerStatus: 400 },
    });
    expect([refused, limited, broken].map(isTelegramRichMessageRefusal)).toEqual([true, false, false]);
    expect(isTelegramRichMessageRefusal(new Error("Bad Request"))).toBe(false);
  });

  it("logs an ambiguous success envelope without exposing message content", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      telegramResponse({ unexpected: true }),
    );

    await expect(
      postTelegramRichMessage("Чувствительный ответ", telegramTarget()),
    ).rejects.toThrow("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS");

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS"),
    );
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.stringContaining("Чувствительный ответ"),
    );
  });
});
