/**
 * Workspace-to-Telegram delivery tests.
 *
 * Constructs covered:
 * - `deliverWorkspaceFile`: explicit photo/document multipart uploads to the current chat/topic.
 * - Ambiguous transport failures never claim that the file was delivered.
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
});
