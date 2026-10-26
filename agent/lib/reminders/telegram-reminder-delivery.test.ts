/**
 * Proactive Telegram reminder delivery tests.
 *
 * Constructs covered:
 * - Deterministic delayed text and forum-topic targeting.
 * - The header "⏰ Напоминание:" is bold through Telegram entities, so the reminder text itself is
 *   sent as is and needs no escaping.
 * - Provider rejection and timeout errors propagate to the durable dispatcher.
 * - A reminder with reply buttons goes out as a rich message with the buttons inside it, its text
 *   staged first and the set activated under the confirmed message; the receipt keeps the plain
 *   text. One without buttons goes out as before and stages nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const buttons = vi.hoisted(() => ({
  activate: vi.fn(),
  stageForReminder: vi.fn(),
}));
vi.mock("../reply-buttons/reply-button-repository.js", () => ({ replyButtonRepository: buttons }));

import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";

const delayedJob: ClaimedReminder = {
  addresseeTelegramUserId: "202",
  buttons: null,
  familyId: "00000000-0000-4000-8000-000000000010",
  forumTopicId: "77",
  content: "Собрать документы",
  delayed: true,
  dueAt: "2026-07-13T06:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: "77",
  groupId: "00000000-0000-4000-8000-000000000012",
  ownerUserId: null,
  scope: "family",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  timezone: "Europe/Moscow",
};

describe("deliverTelegramReminder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    buttons.activate.mockReset();
    buttons.stageForReminder.mockReset();
  });

  it("sends delayed reminder text to the persisted chat and topic", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { chat: { id: -1001, type: "supergroup" }, message_id: 55 },
    }), { status: 200 }));

    await expect(deliverTelegramReminder(delayedJob)).resolves.toEqual({
      messageId: "55",
      text: [
        "⏰ Напоминание:",
        "Собрать документы",
        "Доставлено с задержкой. Изначальное время: 13 июл. 2026 г., 09:00 (Europe/Moscow).",
      ].join("\n\n"),
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      chat_id: "-1001",
      // Offsets are UTF-16 code units: the alarm clock is one unit, the whole header fourteen.
      entities: [{ length: 14, offset: 0, type: "bold" }],
      message_thread_id: 77,
      text: [
        "⏰ Напоминание:",
        "Собрать документы",
        "Доставлено с задержкой. Изначальное время: 13 июл. 2026 г., 09:00 (Europe/Moscow).",
      ].join("\n\n"),
    });
  });

  it("sends a reminder with buttons as a rich message and activates them under it", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { chat: { id: 101, type: "private" }, message_id: 56 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = [[{ color: "green", text: "✅ Оплатил" }, { text: "⏰ Через час" }]];
    buttons.stageForReminder.mockResolvedValue({ buttons: rows, id: "set-1", token: "A".repeat(22) });
    const job: ClaimedReminder = {
      ...delayedJob, buttons: rows as ClaimedReminder["buttons"], delayed: false, forumTopicId: null,
      messageThreadId: null, scope: "personal", telegramChatId: "101", telegramChatType: "private",
    };

    await expect(deliverTelegramReminder(job)).resolves.toEqual({
      messageId: "56",
      text: "⏰ Напоминание:\n\nСобрать документы",
    });

    const text = "**⏰ Напоминание:**\n\n<p>Собрать документы</p>";
    expect(buttons.stageForReminder).toHaveBeenCalledWith(expect.objectContaining({
      addresseeTelegramUserId: "202",
      messageText: text,
      reminderId: job.id,
      telegramChatId: "101",
      telegramChatType: "private",
    }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/sendRichMessage$/u);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      chat_id: "101",
      rich_message: {
        markdown: `${text}\n\n<tg-button-row><tg-button type="callback_data" data="rb:${"A".repeat(22)}:0" style="success">✅ Оплатил</tg-button>` +
          `<tg-button type="callback_data" data="rb:${"A".repeat(22)}:1">⏰ Через час</tg-button></tg-button-row>`,
      },
    });
    expect(buttons.activate).toHaveBeenCalledWith("set-1", "56");
  });

  it("sends an ordinary message and stages nothing for a reminder without buttons", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { chat: { id: -1001, type: "supergroup" }, message_id: 57 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverTelegramReminder(delayedJob);

    expect(buttons.stageForReminder).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/sendMessage$/u);
  });

  it("reports a Telegram refusal with the code the dispatcher stores", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));

    await expect(deliverTelegramReminder(delayedJob)).rejects.toMatchObject({
      code: "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED",
    });
  });

  it("marks an accepted reminder without a message id as possibly delivered", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    })));

    await expect(deliverTelegramReminder(delayedJob)).rejects.toMatchObject({
      code: "AGENT_REMINDER_TELEGRAM_DELIVERY_AMBIGUOUS",
    });
  });

  it.each([
    new Response("{}", { status: 503 }),
    new DOMException("timed out", "TimeoutError"),
  ])("propagates provider failure %s", async (failure) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure)
      ),
    );

    await expect(deliverTelegramReminder(delayedJob)).rejects.toBeDefined();
  });
});
