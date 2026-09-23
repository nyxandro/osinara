/**
 * Workspace-to-Telegram delivery tests.
 *
 * Constructs covered:
 * - `deliverWorkspaceFile`: explicit photo/document/voice multipart uploads to the current chat/topic.
 * - A voice note accepts only Ogg Opus and names a recipient's voice-message privacy refusal.
 * - Transport and unparseable success responses remain ambiguous after delivery begins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverWorkspaceFile } from "./telegram-workspace-file-delivery.js";

const originalToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
});

describe("deliverWorkspaceFile", () => {
  it.each([
    ["photo", "sendPhoto", "photo"],
    ["document", "sendDocument", "document"],
  ] as const)("uploads a %s through Telegram %s", async (presentation, method, field) => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 77 } }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));

    const result = await deliverWorkspaceFile({
      bytes: Buffer.from("file bytes"),
      caption: "**Запрошенный файл**",
      chatId: "101",
      fileName: "image.png",
      mediaType: "image/png",
      messageThreadId: 12,
      presentation,
    }, fetchMock);

    expect(result).toEqual({ telegramMessageId: "77" });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/${method}`);
    const form = request.body as FormData;
    expect(form.get("chat_id")).toBe("101");
    expect(form.get("message_thread_id")).toBe("12");
    expect(form.get("caption")).toBe("<b>Запрошенный файл</b>");
    expect(form.get("parse_mode")).toBe("HTML");
    expect(form.get(field)).toBeInstanceOf(Blob);
  });

  it("uploads an Ogg Opus voice note through Telegram sendVoice", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 78 } }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("voice bytes"),
      caption: "Ссылка: https://example.com",
      chatId: "101",
      fileName: "voice-1.ogg",
      mediaType: "audio/ogg; codecs=opus",
      presentation: "voice",
    }, fetchMock)).resolves.toEqual({ telegramMessageId: "78" });

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sendVoice");
    const form = request.body as FormData;
    const voice = form.get("voice") as Blob;
    expect(voice).toBeInstanceOf(Blob);
    expect(voice.type).toBe("audio/ogg; codecs=opus");
    expect(form.get("caption")).toBe("Ссылка: https://example.com");
    expect(form.get("document")).toBeNull();
  });

  it("rejects a non-Opus voice presentation before contacting Telegram", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn();

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("mp3"),
      chatId: "101",
      fileName: "voice.mp3",
      mediaType: "audio/mpeg",
      presentation: "voice",
    }, fetchMock)).rejects.toThrowError(/AGENT_TELEGRAM_VOICE_TYPE_INVALID/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a recipient who forbids voice messages as a definitive refusal", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("voice bytes"),
      chatId: "101",
      fileName: "voice-1.ogg",
      mediaType: "audio/ogg; codecs=opus",
      presentation: "voice",
    }, vi.fn().mockResolvedValue(new Response(JSON.stringify({
      description: "Bad Request: VOICE_MESSAGES_FORBIDDEN",
      error_code: 400,
      ok: false,
    }), { headers: { "content-type": "application/json" }, status: 400 }))))
      .rejects.toThrowError(/AGENT_TELEGRAM_VOICE_FORBIDDEN/u);
    consoleError.mockRestore();
  });

  it("rejects a non-image photo presentation before contacting Telegram", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn();

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "photo",
    }, fetchMock)).rejects.toThrowError(/AGENT_TELEGRAM_PHOTO_TYPE_INVALID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a network failure as ambiguous", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret-token";

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "document",
    }, vi.fn().mockRejectedValue(new Error("socket closed"))))
      .rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/);
  });

  it.each([
    ["unparseable", new Response("not-json", { status: 200 })],
    ["missing receipt", new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })],
  ])("marks a %s success response as ambiguous", async (_case, response) => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "document",
    }, vi.fn().mockResolvedValue(response)))
      .rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u);
  });
});
