/**
 * Native Telegram Rich Message delivery tests.
 *
 * Constructs covered:
 * - RichBlockThinking and text updates reuse one draft per private chat/topic.
 * - Completed output is persisted with sendRichMessage and anchors group conversations.
 * - The first chunk of a group response replies to the verified triggering message.
 * - Telegram rejection and ambiguous transport failures remain fail-fast without retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  postTelegramRichMessage,
  startTelegramRichThinkingDraft,
  streamTelegramRichMessageDraft,
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

describe("Telegram rich drafts", () => {
  it("starts a native RichBlockThinking draft in a private chat", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(telegramResponse(true));

    await startTelegramRichThinkingDraft(
      telegramTarget({ messageThreadId: 42 }),
    );

    expect(String(telegramFetch.mock.calls[0]![0])).toBe(
      "https://api.telegram.org/bottelegram-bot-secret/sendRichMessageDraft",
    );
    expect(requestBody(telegramFetch)).toMatchObject({
      chat_id: 123456789,
      message_thread_id: 42,
      rich_message: { html: expect.stringContaining("<tg-thinking>") },
    });
  });

  it("reuses one draft for thinking, all steps, and later turns in the same chat", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => telegramResponse(true));
    const target = telegramTarget();

    await startTelegramRichThinkingDraft(target);
    await streamTelegramRichMessageDraft(
      {
        messageSoFar: "Первый шаг",
        stepIndex: 0,
        turnId: "turn_first",
      },
      target,
    );
    await streamTelegramRichMessageDraft(
      {
        messageSoFar: "Следующий ответ",
        stepIndex: 2,
        turnId: "turn_next",
      },
      target,
    );

    const ids = telegramFetch.mock.calls.map(
      (_call, index) => requestBody(telegramFetch, index).draft_id,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("keeps partial MiniMax thinking private until visible answer text arrives", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(telegramResponse(true));
    const target = telegramTarget();

    await streamTelegramRichMessageDraft(
      {
        messageSoFar: "<thi",
        stepIndex: 0,
        turnId: "turn_minimax",
      },
      target,
    );
    await streamTelegramRichMessageDraft(
      {
        messageSoFar: "<think>Скрытое рассуждение</think>\n\nВидимый ответ",
        stepIndex: 0,
        turnId: "turn_minimax",
      },
      target,
    );

    expect(telegramFetch).toHaveBeenCalledOnce();
    const body = requestBody(telegramFetch);
    expect(body.rich_message).toEqual({ markdown: "Видимый ответ" });
  });

  it("keeps independent drafts for different private topics", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => telegramResponse(true));

    await startTelegramRichThinkingDraft(
      telegramTarget({ messageThreadId: 41 }),
    );
    await startTelegramRichThinkingDraft(
      telegramTarget({ messageThreadId: 42 }),
    );

    expect(requestBody(telegramFetch, 0).draft_id).not.toBe(
      requestBody(telegramFetch, 1).draft_id,
    );
  });

  it("does not create rich drafts outside private chats", async () => {
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(telegramResponse(true));

    await startTelegramRichThinkingDraft(
      telegramTarget({ chatId: "-100123", chatType: "supergroup" }),
    );

    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("does not retry a rejected thinking draft", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const telegramFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ description: "Too Many Requests", ok: false }),
          { headers: { "content-type": "application/json" }, status: 429 },
        ),
      );

    await expect(
      startTelegramRichThinkingDraft(telegramTarget()),
    ).rejects.toThrow("AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED");

    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
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
