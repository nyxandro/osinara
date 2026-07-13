/**
 * Overdue task Telegram delivery boundary tests.
 *
 * Constructs covered:
 * - Persisted family topic targeting and provider failure propagation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverOverdueTask } from "./task-overdue-dispatcher.js";

const job = {
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: "42",
  telegramChatId: "-1001",
  title: "Забрать заказ",
};

describe("deliverOverdueTask", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends deterministic text to the persisted family topic", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverOverdueTask(job)).resolves.toBeUndefined();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      chat_id: "-1001",
      message_thread_id: 42,
      text: "Семейная задача просрочена больше чем на сутки:\n\nЗабрать заказ",
    });
  });

  it("propagates Telegram rejection to the durable dispatcher", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));

    await expect(deliverOverdueTask(job)).rejects.toThrow();
  });
});
