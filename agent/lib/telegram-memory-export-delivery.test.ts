/**
 * Telegram memory export delivery tests.
 *
 * Constructs covered:
 * - JSON and Markdown are sent atomically as multipart documents.
 * - Provider rejection produces a stable safe error without exposing the bot token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverMemoryExportFiles } from "./telegram-memory-export-delivery.js";

const originalToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
});

describe("deliverMemoryExportFiles", () => {
  it("sends both formats in one Telegram media group", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{\"ok\":true}", { status: 200 }));

    await deliverMemoryExportFiles(
      { chatId: "101", json: "{\"schemaVersion\":1}", markdown: "# Память" },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sendMediaGroup");
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get("chat_id")).toBe("101");
    expect(String(form.get("media"))).toContain("attach://memory_json");
    expect(form.get("memory_json")).toBeInstanceOf(Blob);
    expect(form.get("memory_markdown")).toBeInstanceOf(Blob);
  });

  it("returns a safe stable error when Telegram rejects the upload", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret-token";

    await expect(
      deliverMemoryExportFiles(
        { chatId: "101", json: "{}", markdown: "# Память" },
        vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EXPORT_DELIVERY_FAILED/);
  });

  it("marks a network failure as ambiguous instead of encouraging a duplicate retry", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret-token";

    await expect(
      deliverMemoryExportFiles(
        { chatId: "101", json: "{}", markdown: "# Память" },
        vi.fn().mockRejectedValue(new Error("socket closed after upload")),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EXPORT_DELIVERY_AMBIGUOUS/);
  });
});
