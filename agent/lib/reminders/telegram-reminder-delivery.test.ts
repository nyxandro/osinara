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
 *   text. One without buttons goes out as before and stages nothing. When Telegram refuses the
 *   rich message, the reminder goes once more as an ordinary message with the text as written and
 *   its buttons are discarded; any other failure is not sent again.
 * - Markup and files make the reminder a rich message laid out like an answer, as written. A
 *   file is read with the rights of the reminder's author and goes inside the message; one that
 *   cannot go leaves a visible line; the files of a message with buttons stay with its set. Files
 *   that cannot be read at all cost the reminder nothing but their lines: it is never sent twice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const buttons = vi.hoisted(() => ({
  activate: vi.fn(),
  discard: vi.fn(),
  stageForReminder: vi.fn(),
}));
vi.mock("../reply-buttons/reply-button-repository.js", () => ({ replyButtonRepository: buttons }));
const resolver = vi.hoisted(() => ({ load: vi.fn(), measure: vi.fn() }));
vi.mock("../answer-files/answer-file-resolution.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../answer-files/answer-file-resolution.js")>(),
  answerFileResolver: resolver,
}));

import type { ResolvedAnswerFile } from "../answer-files/answer-file-resolution.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";

const delayedJob: ClaimedReminder = {
  addresseeTelegramUserId: "202",
  authorRole: "member",
  authorUserId: "00000000-0000-4000-8000-000000000020",
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

const personalJob: ClaimedReminder = {
  ...delayedJob, delayed: false, forumTopicId: null, groupId: null, messageThreadId: null,
  ownerUserId: delayedJob.authorUserId, scope: "personal", telegramChatId: "101", telegramChatType: "private",
};

function document(path: string): ResolvedAnswerFile {
  return {
    byteSize: 3, bytes: Buffer.from("pdf"), fileName: path.split("/").at(-1)!, kind: "document",
    mediaType: "application/pdf", path, scope: "personal", sha256: "sha-1",
  };
}

function sent(messageId: number, richMessage?: unknown) {
  return new Response(JSON.stringify({
    ok: true,
    result: { chat: { id: 101, type: "private" }, message_id: messageId, ...(richMessage === undefined ? {} : { rich_message: richMessage }) },
  }), { status: 200 });
}

function richMessageOf(call: unknown[] | undefined): { markdown: string; media?: unknown } {
  const body = (call?.[1] as RequestInit).body;
  return body instanceof FormData
    ? JSON.parse(String(body.get("rich_message")))
    : JSON.parse(String(body)).rich_message;
}

describe("deliverTelegramReminder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetAllMocks();
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
    expect(buttons.activate).toHaveBeenCalledWith("set-1", "56", []);
  });

  it("lays out a reminder with markup like an answer under a bold header, as written", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(sent(60));
    vi.stubGlobal("fetch", fetchMock);
    const steps = Array.from({ length: 8 }, (_, index) => `- шаг ${index + 1}`).join("\n");

    await deliverTelegramReminder({ ...personalJob, content: `**Утренняя зарядка**\n\n${steps}` });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/sendRichMessage$/u);
    const { markdown } = richMessageOf(fetchMock.mock.calls[0]);
    expect(markdown.startsWith("**⏰ Напоминание:**\n\n**Утренняя зарядка**")).toBe(true);
    expect(markdown).toContain("- шаг 8");
    expect(markdown).not.toContain("<details>");
  });

  it("sends a file of the author's folder inside the reminder, read with the author's rights", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(sent(61));
    vi.stubGlobal("fetch", fetchMock);
    resolver.load.mockResolvedValue({ file: document("bills/oct.pdf"), ok: true });
    resolver.measure.mockResolvedValue({ file: { byteSize: 3, fileName: "oct.pdf", path: "bills/oct.pdf", scope: "personal" }, ok: true });

    await expect(deliverTelegramReminder({ ...personalJob, content: "Оплатить счёт\n\n![Счёт за октябрь](/workspace/personal/bills/oct.pdf)" }))
      .resolves.toEqual({
        messageId: "61",
        text: "⏰ Напоминание:\n\nОплатить счёт\n\n![Счёт за октябрь](/workspace/personal/bills/oct.pdf)",
      });

    expect(resolver.load).toHaveBeenCalledWith({
      familyId: delayedJob.familyId, groupId: null, groupType: null, role: "member",
      telegramChatType: "private", userId: delayedJob.authorUserId,
    }, expect.objectContaining({ path: "bills/oct.pdf", scope: "personal" }));
    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("chat_id")).toBe("101");
    expect(form.get("f0")).toBeInstanceOf(Blob);
    expect(richMessageOf(fetchMock.mock.calls[0])).toEqual({
      markdown: "**⏰ Напоминание:**\n\nОплатить счёт\n\n![](tg://document?id=f0 \"Счёт за октябрь\")",
      media: [{ id: "f0", media: { media: "attach://f0", type: "document" } }],
    });
  });

  it("keeps the files of a reminder with buttons for the edit that answers a press", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(sent(62, { blocks: [{ document: { file_id: "doc-file" }, type: "document" }] }));
    vi.stubGlobal("fetch", fetchMock);
    resolver.load.mockResolvedValue({ file: document("bills/oct.pdf"), ok: true });
    resolver.measure.mockResolvedValue({ file: { byteSize: 3, fileName: "oct.pdf", path: "bills/oct.pdf", scope: "personal" }, ok: true });
    const rows = [[{ text: "✅ Оплатил" }]];
    buttons.stageForReminder.mockResolvedValue({ buttons: rows, id: "set-1", token: "A".repeat(22) });

    await deliverTelegramReminder({
      ...personalJob, buttons: rows as ClaimedReminder["buttons"],
      content: "Оплатить счёт\n\n![](/workspace/personal/bills/oct.pdf)",
    });

    const messageText = "**⏰ Напоминание:**\n\nОплатить счёт\n\n![](tg://document?id=f0)";
    expect(buttons.stageForReminder).toHaveBeenCalledWith(expect.objectContaining({ messageText }));
    expect(richMessageOf(fetchMock.mock.calls[0]).markdown.startsWith(`${messageText}\n\n<tg-button-row>`)).toBe(true);
    expect(buttons.activate).toHaveBeenCalledWith("set-1", "62", [{ fileId: "doc-file", id: "f0", kind: "document" }]);
  });

  it("puts a visible line in place of a file that is gone", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(sent(63));
    vi.stubGlobal("fetch", fetchMock);
    resolver.measure.mockResolvedValue({ ok: false, problem: "not_found" });

    await deliverTelegramReminder({ ...personalJob, content: "Оплатить счёт\n\n![Счёт](/workspace/personal/bills/oct.pdf)" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/sendMessage$/u);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).text).toBe(
      "⏰ Напоминание:\n\nОплатить счёт\n\n⚠️ Не удалось приложить «oct.pdf»: файл не найден (AGENT_ANSWER_FILE_NOT_FOUND)",
    );
    expect(resolver.load).not.toHaveBeenCalled();
  });

  it("sends the text on time with a line in place of a file that could not be read at all", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(sent(65));
    vi.stubGlobal("fetch", fetchMock);
    resolver.measure.mockRejectedValue(new Error("database unavailable"));

    await expect(deliverTelegramReminder({ ...personalJob, content: "Оплатить счёт\n\n![](/workspace/personal/bills/oct.pdf)" }))
      .resolves.toMatchObject({ messageId: "65" });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).text).toBe(
      "⏰ Напоминание:\n\nОплатить счёт\n\n⚠️ Не удалось приложить «oct.pdf»: файл не удалось прочитать (AGENT_ANSWER_FILE_READ_FAILED)",
    );
  });

  it("does not send a reminder with a file again after a failure whose outcome is unknown", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    resolver.load.mockResolvedValue({ file: document("bills/oct.pdf"), ok: true });
    resolver.measure.mockResolvedValue({ file: { byteSize: 3, fileName: "oct.pdf", path: "bills/oct.pdf", scope: "personal" }, ok: true });

    await expect(deliverTelegramReminder({ ...personalJob, content: "Оплатить счёт\n\n![](/workspace/personal/bills/oct.pdf)" }))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards the buttons and sends the text as written when Telegram refuses buttons with a file", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ description: "Bad Request", error_code: 400, ok: false }), { status: 400 }))
      .mockResolvedValueOnce(sent(66));
    vi.stubGlobal("fetch", fetchMock);
    resolver.load.mockResolvedValue({ file: document("bills/oct.pdf"), ok: true });
    resolver.measure.mockResolvedValue({ file: { byteSize: 3, fileName: "oct.pdf", path: "bills/oct.pdf", scope: "personal" }, ok: true });
    const rows = [[{ text: "✅ Оплатил" }]];
    buttons.stageForReminder.mockResolvedValue({ buttons: rows, id: "set-1", token: "A".repeat(22) });

    await deliverTelegramReminder({
      ...personalJob, buttons: rows as ClaimedReminder["buttons"], content: "Оплатить счёт\n\n![](/workspace/personal/bills/oct.pdf)",
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["sendRichMessage", "sendMessage"]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)).text)
      .toBe("⏰ Напоминание:\n\nОплатить счёт\n\n⚠️ Не удалось приложить «oct.pdf»: Telegram не принял файл (AGENT_ANSWER_FILE_REFUSED)");
    expect(buttons.discard).toHaveBeenCalledWith("set-1");
    expect(buttons.activate).not.toHaveBeenCalled();
  });

  it("sends the text as written when Telegram refuses the rich message with a file", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ description: "Bad Request: wrong file", error_code: 400, ok: false }), { status: 400 }))
      .mockResolvedValueOnce(sent(64));
    vi.stubGlobal("fetch", fetchMock);
    resolver.load.mockResolvedValue({ file: document("bills/oct.pdf"), ok: true });
    resolver.measure.mockResolvedValue({ file: { byteSize: 3, fileName: "oct.pdf", path: "bills/oct.pdf", scope: "personal" }, ok: true });

    await expect(deliverTelegramReminder({ ...personalJob, content: "**Оплатить** счёт\n\n![](/workspace/personal/bills/oct.pdf)" }))
      .resolves.toMatchObject({ messageId: "64" });

    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["sendRichMessage", "sendMessage"]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      chat_id: "101",
      entities: [{ length: 14, offset: 0, type: "bold" }],
      text: "⏰ Напоминание:\n\n**Оплатить** счёт\n\n⚠️ Не удалось приложить «oct.pdf»: Telegram не принял файл (AGENT_ANSWER_FILE_REFUSED)",
    });
  });

  it("sends the reminder as an ordinary message when Telegram refuses it with buttons", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ description: "Bad Request: BUTTON_TEXT_INVALID", error_code: 400, ok: false }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { chat: { id: 101, type: "private" }, message_id: 58 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = [[{ text: "✅ Оплатил" }]];
    buttons.stageForReminder.mockResolvedValue({ buttons: rows, id: "set-1", token: "A".repeat(22) });
    const job: ClaimedReminder = {
      ...delayedJob, buttons: rows as ClaimedReminder["buttons"], delayed: false, forumTopicId: null,
      messageThreadId: null, scope: "personal", telegramChatId: "101", telegramChatType: "private",
    };

    await expect(deliverTelegramReminder(job)).resolves.toEqual({ messageId: "58", text: "⏰ Напоминание:\n\nСобрать документы" });

    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["sendRichMessage", "sendMessage"]);
    expect(buttons.discard).toHaveBeenCalledWith("set-1");
    expect(buttons.activate).not.toHaveBeenCalled();
  });

  it("does not send a reminder with buttons again after any other failure", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    buttons.stageForReminder.mockResolvedValue({ buttons: [[{ text: "✅ Оплатил" }]], id: "set-1", token: "A".repeat(22) });
    const job: ClaimedReminder = {
      ...delayedJob, buttons: [[{ text: "✅ Оплатил" }]] as ClaimedReminder["buttons"], delayed: false,
      forumTopicId: null, messageThreadId: null, scope: "personal", telegramChatId: "101", telegramChatType: "private",
    };

    await expect(deliverTelegramReminder(job)).rejects.toMatchObject({ code: "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(buttons.discard).not.toHaveBeenCalled();
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
