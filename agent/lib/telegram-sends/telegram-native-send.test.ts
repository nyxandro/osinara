/**
 * One native Telegram message a tool sends on its own.
 *
 * Constructs covered:
 * - `sendTelegramNativeMessage`: the method body goes with the chat, topic and group reply; the
 *   confirmed message id comes back.
 * - A refusal is definitive; a lost connection, a server error or an answer without a message id
 *   is ambiguous.
 * - A widget goes to the beta address, and a refusal the tool lists keeps its own code (#468).
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

  it("sends a widget to the beta address and keeps a listed refusal's own code", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-token");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const widget = (fetchImplementation: ReturnType<typeof telegram>) => sendTelegramNativeMessage({
      apiBaseUrl: "https://api.telegram.org/beta",
      body: { caption: "Меню", html: "<b>x</b>" },
      codes: CODES,
      method: "sendWidget",
      refusals: [{ code: "AGENT_WIDGET_TOO_LARGE", message: "Слишком большой", telegramError: "INPUT_MEDIA_WIDGET_TOO_LARGE" }],
      target: { chatId: "42" },
    }, fetchImplementation as unknown as typeof fetch);

    const sent = telegram(json({ ok: true, result: { message_id: 7097, widget: { html: "<b>x</b>" } } }));
    await expect(widget(sent)).resolves.toEqual({ telegramMessageId: "7097" });
    expect((sent.mock.calls[0] as unknown as [string])[0]).toBe("https://api.telegram.org/beta/bot123456:test-token/sendWidget");

    await expect(widget(telegram(json({ description: "Bad Request: INPUT_MEDIA_WIDGET_TOO_LARGE", error_code: 400, ok: false }, 400))))
      .rejects.toMatchObject({ code: "AGENT_WIDGET_TOO_LARGE" });
    await expect(widget(telegram(json({ description: "Bad Request: CHAT_SEND_PHOTOS_FORBIDDEN", error_code: 400, ok: false }, 400))))
      .rejects.toMatchObject({ code: CODES.failed });
  });
});
