/**
 * Telegram animation delivery tests.
 *
 * Constructs covered:
 * - `sendAnimation` carries the KLIPY URL unchanged, its size, the topic, the reply and the caption
 *   rendered as Telegram HTML.
 * - A refused send is definitive; a lost connection or an unconfirmed answer is ambiguous.
 * - A caption over Telegram's limit is refused before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendTelegramAnimation } from "./telegram-animation-delivery.js";

const ANIMATION = {
  chatId: "-1001",
  height: 260,
  url: "https://static.klipy.com/ii/abc/hd.mp4?token=keep",
  width: 498,
};

function telegramOk(messageId: unknown = 77): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
}

function sentBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Telegram animation delivery", () => {
  it("sends the KLIPY URL unchanged into the current topic as a reply", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(telegramOk());

    await expect(sendTelegramAnimation({
      ...ANIMATION,
      caption: "**ну-ну**",
      messageThreadId: 7,
      replyToMessageId: 41,
    }, fetchMock)).resolves.toEqual({ telegramMessageId: "77" });

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.telegram.org/bot123:test-token/sendAnimation");
    expect(sentBody(fetchMock)).toEqual({
      animation: "https://static.klipy.com/ii/abc/hd.mp4?token=keep",
      caption: "<b>ну-ну</b>",
      chat_id: "-1001",
      height: 260,
      message_thread_id: 7,
      parse_mode: "HTML",
      reply_parameters: { allow_sending_without_reply: true, message_id: 41 },
      width: 498,
    });
  });

  it("sends a bare animation without caption or reply fields", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(telegramOk());

    await sendTelegramAnimation(ANIMATION, fetchMock);

    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(["animation", "chat_id", "height", "width"]);
  });

  it("treats a refused send as definitive and logs Telegram's reason", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      description: "Bad Request: failed to get HTTP URL content",
      ok: false,
    }), { status: 400 }));

    await expect(sendTelegramAnimation(ANIMATION, fetchMock)).rejects.toMatchObject({ code: "AGENT_GIF_DELIVERY_FAILED" });
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      code: "AGENT_GIF_DELIVERY_FAILED",
      description: "Bad Request: failed to get HTTP URL content",
      providerStatus: 400,
    });
  });

  it.each([
    ["a lost connection", () => Promise.reject(new TypeError("fetch failed"))],
    ["an answer without a message id", () => Promise.resolve(telegramOk("not-a-number"))],
  ])("treats %s as an unconfirmed delivery", async (_label, answer) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(answer);

    await expect(sendTelegramAnimation(ANIMATION, fetchMock)).rejects.toMatchObject({ code: "AGENT_GIF_DELIVERY_AMBIGUOUS" });
  });

  it("refuses a caption over Telegram's limit before sending", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(sendTelegramAnimation({ ...ANIMATION, caption: "а".repeat(1_025) }, fetchMock))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CAPTION_TOO_LONG" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
