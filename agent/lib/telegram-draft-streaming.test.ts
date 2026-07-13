/**
 * Native Telegram draft streaming tests.
 *
 * Constructs covered:
 * - `streamTelegramMessageDraft`: immediately sends cumulative Eve output to a private draft.
 * - Stable per-step draft identifiers preserve one animated Telegram preview.
 * - Group chats remain on completed-message delivery because Telegram drafts are private-only.
 * - Telegram rejection and timeout paths fail once with stable diagnostics and no retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamTelegramMessageDraft } from "./telegram-draft-streaming.js";

beforeEach(() => vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function telegramTarget(overrides: Partial<{
  chatId: string;
  chatType: "group" | "private" | "supergroup";
  messageThreadId: number;
}> = {}) {
  return {
    chatId: overrides.chatId ?? "123456789",
    chatType: overrides.chatType ?? "private",
    messageThreadId: overrides.messageThreadId,
  };
}

function successfulTelegramFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
    JSON.stringify({ ok: true, result: true }),
    { headers: { "content-type": "application/json" }, status: 200 },
  ));
}

function requestBody(fetchMock: ReturnType<typeof successfulTelegramFetch>, index: number) {
  const init = fetchMock.mock.calls[index]![1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("streamTelegramMessageDraft", () => {
  it("immediately streams every cumulative update into one formatted private-chat draft", async () => {
    const telegramFetch = successfulTelegramFetch();
    const telegram = telegramTarget({ messageThreadId: 42 });

    await streamTelegramMessageDraft({
      messageSoFar: "**Первый** фрагмент",
      stepIndex: 0,
      turnId: "turn_01KXB392VJ8YY13JMJ9YZAF5QR",
    }, telegram);
    await streamTelegramMessageDraft({
      messageSoFar: "**Первый** фрагмент и продолжение",
      stepIndex: 0,
      turnId: "turn_01KXB392VJ8YY13JMJ9YZAF5QR",
    }, telegram);

    expect(telegramFetch).toHaveBeenCalledTimes(2);
    for (const [url] of telegramFetch.mock.calls) {
      expect(String(url)).toBe(
        "https://api.telegram.org/bottelegram-bot-secret/sendMessageDraft",
      );
    }
    const firstBody = requestBody(telegramFetch, 0);
    const secondBody = requestBody(telegramFetch, 1);
    expect(firstBody).toMatchObject({
      chat_id: 123456789,
      message_thread_id: 42,
      parse_mode: "HTML",
      text: "<b>Первый</b> фрагмент",
    });
    expect(secondBody).toMatchObject({
      chat_id: 123456789,
      message_thread_id: 42,
      parse_mode: "HTML",
      text: "<b>Первый</b> фрагмент и продолжение",
    });
    expect(firstBody.draft_id).toBe(secondBody.draft_id);
    expect(firstBody.draft_id).toBeGreaterThan(0);
    expect(Number.isSafeInteger(firstBody.draft_id)).toBe(true);
  });

  it("uses a different draft for each assistant step in the same turn", async () => {
    const telegramFetch = successfulTelegramFetch();
    const telegram = telegramTarget();
    const base = {
      messageSoFar: "Текст",
      turnId: "turn_01KXB392VJ8YY13JMJ9YZAF5QR",
    };

    await streamTelegramMessageDraft({ ...base, stepIndex: 0 }, telegram);
    await streamTelegramMessageDraft({ ...base, stepIndex: 1 }, telegram);

    expect(requestBody(telegramFetch, 0).draft_id).not.toBe(
      requestBody(telegramFetch, 1).draft_id,
    );
  });

  it("does not emulate drafts in Telegram groups", async () => {
    const telegramFetch = successfulTelegramFetch();

    await streamTelegramMessageDraft({
      messageSoFar: "Готовый фрагмент",
      stepIndex: 0,
      turnId: "turn_group",
    }, telegramTarget({ chatId: "-100123", chatType: "supergroup" }));

    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("does not resend an unchanged preview after the native draft limit is exceeded", async () => {
    const telegramFetch = successfulTelegramFetch();

    await streamTelegramMessageDraft({
      messageSoFar: "текст ".repeat(1_000),
      stepIndex: 0,
      turnId: "turn_long",
    }, telegramTarget());

    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid private chat id before calling Telegram", async () => {
    const telegramFetch = successfulTelegramFetch();

    await expect(streamTelegramMessageDraft({
      messageSoFar: "Текст",
      stepIndex: 0,
      turnId: "turn_invalid_chat",
    }, telegramTarget({ chatId: "not-a-chat-id" }))).rejects.toThrow(
      "AGENT_TELEGRAM_DRAFT_CHAT_ID_INVALID",
    );
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("fails when Telegram returns an invalid success envelope", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));

    await expect(streamTelegramMessageDraft({
      messageSoFar: "Текст",
      stepIndex: 0,
      turnId: "turn_invalid_response",
    }, telegramTarget())).rejects.toThrow("AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED");
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("fails with a stable error when Telegram rejects a draft update", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ description: "Too Many Requests", ok: false }),
      { headers: { "content-type": "application/json" }, status: 429 },
    ));

    await expect(streamTelegramMessageDraft({
      messageSoFar: "Текст",
      stepIndex: 0,
      turnId: "turn_rate_limited",
    }, telegramTarget())).rejects.toThrow("AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED");
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("rethrows a timed-out Telegram request once with a stable diagnostic code", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    await expect(streamTelegramMessageDraft({
      messageSoFar: "Текст",
      stepIndex: 0,
      turnId: "turn_timeout",
    }, telegramTarget())).rejects.toBe(timeout);
    expect(timeout.message).toContain("AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED");
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
  });
});
