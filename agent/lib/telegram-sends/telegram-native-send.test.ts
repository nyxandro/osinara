/**
 * One native Telegram message a tool sends on its own.
 *
 * Constructs covered:
 * - `sendTelegramNativeMessage`: the method body goes with the chat, topic and group reply; the
 *   confirmed message id comes back.
 * - A refusal is definitive; a lost connection, a server error or an answer without a message id
 *   is ambiguous.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { sendTelegramNativeMessage } from "./telegram-native-send.js";

const CODES = {
  ambiguous: "AGENT_TEST_SEND_AMBIGUOUS",
  ambiguousMessage: "Не удалось подтвердить отправку",
  failed: "AGENT_TEST_SEND_FAILED",
  failedMessage: "Telegram не принял сообщение",
};

function telegram(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function send(fetchImplementation: ReturnType<typeof telegram>) {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-token");
  return await sendTelegramNativeMessage({
    body: { latitude: 55.75, longitude: 37.61 },
    codes: CODES,
    method: "sendLocation",
    target: { chatId: "-1001", messageThreadId: 7, replyToMessageId: 41 },
  }, fetchImplementation as unknown as typeof fetch);
}

describe("sendTelegramNativeMessage", () => {
  it("sends the body to the chat and topic as a reply and returns the message id", async () => {
    const fetchImplementation = telegram(json({ ok: true, result: { message_id: 93 } }));

    await expect(send(fetchImplementation)).resolves.toEqual({ telegramMessageId: "93" });

    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sendLocation$/u);
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "-1001",
      latitude: 55.75,
      longitude: 37.61,
      message_thread_id: 7,
      reply_parameters: { allow_sending_without_reply: true, message_id: 41 },
    });
  });

  it("reports a refusal as definitive and a lost answer as ambiguous", async () => {
    await expect(send(telegram(json({ description: "Bad Request: not enough rights", ok: false }, 400))))
      .rejects.toMatchObject({ code: CODES.failed });
    await expect(send(telegram(new TypeError("fetch failed")))).rejects.toMatchObject({ code: CODES.ambiguous });
    // A server error of Telegram's front says nothing about whether the message was already posted.
    await expect(send(telegram(json({ description: "Bad Gateway", ok: false }, 502)))).rejects.toMatchObject({ code: CODES.ambiguous });
    await expect(send(telegram(json({ ok: true, result: {} })))).rejects.toBeInstanceOf(AppError);
    await expect(send(telegram(json({ ok: true, result: {} })))).rejects.toMatchObject({ code: CODES.ambiguous });
  });
});
