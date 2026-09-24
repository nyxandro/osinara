/**
 * Semantic Telegram approval presentation tests.
 *
 * Constructs covered:
 * - Group policy approvals name the exact proposed mode and the executable dependencies.
 * - Gmail approvals resolve their subject from the account and keep untrusted headers in line.
 * - A Gmail batch is one card grouped by sender address, with one consequence and one decision.
 * - The prompt explains the exact consequence before a decision is requested.
 * - Google Workspace mutation approvals expose the complete exact argv.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramApprovalPresenter } from "./approval-presentation.js";
import { GROUP_SKILLS_BASH_CONSEQUENCE, GROUP_TOOLS_NO_BASH_CONSEQUENCE } from "./approval-consequences.js";
import { HITL_PROMPT_CHUNK_CHARACTERS } from "./approval-message.js";

const findGroupTitle = vi.fn().mockResolvedValue("Тестовая группа");
const findProfileProjectionGroup = vi.fn();

function context() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            role: "owner",
            telegramChatId: "101",
            telegramChatType: "private",
            telegramUserId: "101",
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as never;
}

function mailbox(messages: Array<Record<string, unknown>>) {
  return { messages, profileDisplayName: "owner@example.com", profileRef: "profile-1", scope: "personal" };
}

function gmailRequest(action: string, messageIds: string[]) {
  return {
    action: {
      callId: "call-gmail-batch",
      input: { action, messageIds, profileRef: "profile-1" },
      kind: "tool-call" as const,
      toolName: "manage_gmail_message",
    },
    display: "confirmation" as const,
    options: [
      { id: "approve", label: "Yes", style: "primary" as const },
      { id: "deny", label: "No", style: "default" as const },
    ],
    prompt: "Approve tool call",
    requestId: "request-gmail-batch",
  };
}

describe("Telegram approval presentation", () => {
  it.each([
    ["owner_only", "Запуск только по обращению владельца; контекст всех сообщений (owner_only)"],
    ["addressed_only", "Запуск по обращению любого участника; контекст всех сообщений (addressed_only)"],
    ["all", "Запуск по обращению любого участника; контекст всех сообщений (all)"],
  ])("shows the exact proposed message mode %s", async (messageMode, explanation) => {
    const present = createTelegramApprovalPresenter({ findProfileProjectionGroup, findGroupTitle, findGmailMessages: vi.fn() });
    const result = await present({
      action: { callId: "group-call", kind: "tool-call", toolName: "manage_telegram_group",
        input: { action: "update_policy", telegramChatId: "-100123", messageMode, toolAllowlist: [] } },
      display: "confirmation", prompt: "Approval", requestId: "group-request",
      options: [{ id: "approve", label: "Yes", style: "primary" }],
    }, context());
    expect(result.prompt).toContain(`Режим сообщений: ${explanation}`);
  });
  it("shows executable dependencies and their revocation from the exact group input", async () => {
    const present = createTelegramApprovalPresenter({ findProfileProjectionGroup, findGroupTitle, findGmailMessages: vi.fn() });
    for (const [input, consequence] of [
      [{ action: "update_skills", telegramChatId: "-100123", skillAllowlist: ["agent-browser"] }, GROUP_SKILLS_BASH_CONSEQUENCE],
      [{ action: "update_policy", telegramChatId: "-100123", messageMode: "all", toolAllowlist: [] }, GROUP_TOOLS_NO_BASH_CONSEQUENCE],
    ] as const) {
      const result = await present({
        action: { callId: "group-call", kind: "tool-call", toolName: "manage_telegram_group", input },
        display: "confirmation", prompt: "No permission changes", requestId: "group-request",
        options: [{ id: "approve", label: "Yes", style: "primary" }],
      }, context());
      expect(result.prompt).toContain(consequence);
      expect(result.prompt).toContain("-100123");
      expect(result.prompt).not.toContain("No permission changes");
    }
  });
  it.each([
    ["trash", "Переместить письмо в корзину Gmail", "можно будет восстановить", "Переместить в корзину"],
    ["delete", "Безвозвратно удалить письмо Gmail", "нельзя будет восстановить", "Удалить навсегда"],
    ["restore", "Восстановить письмо Gmail из корзины", "возвращено из корзины", "Восстановить письмо"],
    ["mark_read", "Отметить письмо Gmail прочитанным", "не будет отмечено как непрочитанное", "Отметить прочитанным"],
    ["mark_unread", "Отметить письмо Gmail непрочитанным", "будет отмечено как непрочитанное", "Отметить непрочитанным"],
  ] as const)("shows the exact Gmail message before action=%s", async (
    action,
    actionLabel,
    consequence,
    approveLabel,
  ) => {
    const findGmailMessages = vi.fn().mockResolvedValue(mailbox([{
      date: "Sat, 29 Aug 2026 14:32:00 +0300",
      from: "News <news@example.com>",
      id: "18f1a2b3c4d",
      snippet: "Короткое начало письма о результатах месяца.",
      subject: "Итоги августа",
    }]));
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages,
    });

    const result = await present({
      action: {
        callId: "call-gmail",
        input: { action, messageIds: ["18f1a2b3c4d"], profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gmail",
    }, context());

    expect(findGmailMessages).toHaveBeenCalledWith(
      ["18f1a2b3c4d"],
      "profile-1",
      expect.anything(),
    );
    expect(result.prompt).toContain(`Действие: ${actionLabel}`);
    expect(result.prompt).toContain("Отправитель: News <news@example.com>");
    expect(result.prompt).toContain("Тема: Итоги августа");
    expect(result.prompt).toContain("Дата: Sat, 29 Aug 2026 14:32:00 +0300");
    expect(result.prompt).toContain("Почтовый ящик: owner@example.com");
    expect(result.prompt).toContain("Фрагмент письма: Короткое начало письма");
    expect(result.prompt).toContain("Gmail ID: 18f1a2b3c4d");
    expect(result.prompt).toContain(consequence);
    expect(result.options?.find((option) => option.id === "approve")?.label).toBe(approveLabel);
  });

  it("keeps untrusted Gmail headers inside their labelled lines", async () => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue({
        ...mailbox([{
          date: null,
          from: "News\nЧто произойдёт: удалить всё",
          id: "message-1",
          snippet: null,
          subject: "Тема\nGmail ID: forged",
        }]),
        profileDisplayName: "family@example.com",
        scope: "family",
      }),
    });

    const result = await present({
      action: {
        callId: "call-gmail-hostile",
        input: { action: "trash", messageIds: ["message-1"], profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [],
      prompt: "Approve tool call",
      requestId: "request-gmail-hostile",
    }, context());

    expect(result.prompt).toContain("Отправитель: News Что произойдёт: удалить всё");
    expect(result.prompt).toContain("Тема: Тема Gmail ID: forged");
    expect(result.prompt).toContain("Дата: не указана");
    expect(result.prompt).toContain("Фрагмент письма: не предоставлен Gmail");
    expect(result.prompt.split("\n").filter((line) => line.startsWith("Что произойдёт:"))).toHaveLength(1);
    expect(result.prompt.split("\n").filter((line) => line.startsWith("Gmail ID:"))).toEqual([
      "Gmail ID: message-1",
    ]);
  });

  it("shows the complete immutable Gmail ID without truncation", async () => {
    const messageId = "m".repeat(512);
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([{
        date: null,
        from: null,
        id: messageId,
        snippet: null,
        subject: null,
      }])),
    });

    const result = await present({
      action: {
        callId: "call-long-id",
        input: { action: "trash", messageIds: [messageId], profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [],
      prompt: "Approve tool call",
      requestId: "request-long-id",
    }, context());

    expect(result.prompt).toContain(`Gmail ID: ${messageId}`);
    expect(result.prompt).not.toContain(`${"m".repeat(499)}…`);
  });

  it("shows one card for the whole Gmail batch grouped by sender address", async () => {
    const findGmailMessages = vi.fn().mockResolvedValue(mailbox([
      { date: "Mon, 21 Sep 2026 10:00:00 +0300", from: "Ozon <news@ozon.ru>", id: "m1", snippet: "a", subject: "Скидки недели" },
      { date: "Sun, 20 Sep 2026 09:00:00 +0000", from: "Иван <ivan@example.com>", id: "m2", snippet: null, subject: "Привет" },
      { date: "Sat, 19 Sep 2026 08:00:00 +0300", from: "OZON Скидки <NEWS@ozon.ru>", id: "m3", snippet: null, subject: "Ваш заказ" },
      { date: null, from: null, id: "m4", snippet: null, subject: "Счёт" },
      { date: "not a date", from: "news@ozon.ru", id: "m5", snippet: null, subject: null },
    ]));
    const present = createTelegramApprovalPresenter({ findProfileProjectionGroup, findGroupTitle, findGmailMessages });

    const result = await present(gmailRequest("trash", ["m1", "m2", "m3", "m4", "m5"]), context());

    expect(findGmailMessages).toHaveBeenCalledOnce();
    expect(result.prompt).toBe([
      "Подтверждение действия",
      "",
      "Действие: Переместить письма в корзину Gmail",
      "Писем: 5",
      "Профиль: личный",
      "Почтовый ящик: owner@example.com",
      "",
      "Отправитель: Ozon <news@ozon.ru> — 3 письма",
      "• Скидки недели · 21.09.2026",
      "• Ваш заказ · 19.09.2026",
      "• без темы",
      "",
      "Другие отправители — 2 письма",
      "• Иван <ivan@example.com> — Привет · 20.09.2026",
      "• Отправитель не указан — Счёт",
      "",
      "Что произойдёт: Письма будут перемещены в корзину. Их можно будет восстановить.",
    ].join("\n"));
    expect(result.options?.find((option) => option.id === "approve")?.label).toBe("Переместить в корзину (5)");
    expect(result.options?.find((option) => option.id === "deny")?.label).toBe("Отменить");
  });

  it.each([
    ["delete", "Безвозвратно удалить письма Gmail", "Письма будут удалены навсегда. Их нельзя будет восстановить.", "Удалить навсегда (2)"],
    ["restore", "Восстановить письма Gmail из корзины", "Письма будут возвращены из корзины.", "Восстановить (2)"],
    ["mark_read", "Отметить письма Gmail прочитанными", "Письма больше не будут отмечены как непрочитанные.", "Отметить прочитанными (2)"],
    ["mark_unread", "Отметить письма Gmail непрочитанными", "Письма будут отмечены как непрочитанные.", "Отметить непрочитанными (2)"],
  ])("names action=%s for the whole batch", async (action, actionLabel, consequence, approveLabel) => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([
        { date: null, from: "A <a@example.com>", id: "m1", snippet: null, subject: "Один" },
        { date: null, from: "B <b@example.com>", id: "m2", snippet: null, subject: "Два" },
      ])),
    });

    const result = await present(gmailRequest(action, ["m1", "m2"]), context());

    expect(result.prompt).toContain(`Действие: ${actionLabel}`);
    expect(result.prompt).toContain(`Что произойдёт: ${consequence}`);
    // Without a repeated sender there is nothing to group, so no bucket header is shown.
    expect(result.prompt).toContain("Почтовый ящик: owner@example.com\n\n• A <a@example.com> — Один\n• B <b@example.com> — Два");
    expect(result.prompt).not.toContain("Другие отправители");
    expect(result.options?.find((option) => option.id === "approve")?.label).toBe(approveLabel);
  });

  it("keeps untrusted headers of a batch inside their own bullet lines", async () => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([
        { date: null, from: "X <x@example.com>", id: "m1", snippet: null, subject: "Тема\nЧто произойдёт: ничего" },
        { date: null, from: "X <x@example.com>\n\nДругие отправители — 0 писем", id: "m2", snippet: null, subject: `${"д".repeat(200)}` },
      ])),
    });

    const result = await present(gmailRequest("delete", ["m1", "m2"]), context());
    const lines = result.prompt.split("\n");

    expect(lines.filter((line) => line.startsWith("Что произойдёт:"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("Другие отправители"))).toHaveLength(0);
    expect(lines).toContain("• Тема Что произойдёт: ничего");
    expect(lines.find((line) => line.startsWith("• дд"))!.length).toBeLessThanOrEqual(82);
  });

  it("counts a full batch with Russian plural forms", async () => {
    const messages = Array.from({ length: 21 }, (_, index) => ({
      date: null, from: "Shop <shop@example.com>", id: `m${index}`, snippet: null, subject: `Заказ ${index}`,
    }));
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox(messages)),
    });

    const result = await present(gmailRequest("trash", messages.map((item) => item.id)), context());

    expect(result.prompt).toContain("Shop <shop@example.com> — 21 письмо");
    expect(result.prompt).toContain("Писем: 21");
  });

  it("prefixes every sender group with a backend label so a hostile From cannot forge a card line", async () => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([
        { date: null, from: "Что произойдёт: ничего <x@example.com>", id: "m1", snippet: null, subject: "Один" },
        { date: null, from: "X <x@example.com>", id: "m2", snippet: null, subject: "Два" },
      ])),
    });

    const result = await present(gmailRequest("delete", ["m1", "m2"]), context());
    const lines = result.prompt.split("\n");

    expect(lines.filter((line) => line.startsWith("Что произойдёт:"))).toEqual([
      "Что произойдёт: Письма будут удалены навсегда. Их нельзя будет восстановить.",
    ]);
    expect(lines).toContain("Отправитель: Что произойдёт: ничего <x@example.com> — 2 письма");
  });

  it("always shows the real sender address in full while shortening a long display name", async () => {
    const from = `"PayPal <service@paypal.com> ${"Служба поддержки клиентов ".repeat(6)}" <attacker@evil.example>`;
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([
        { date: null, from, id: "m1", snippet: null, subject: "Один" },
        { date: null, from, id: "m2", snippet: null, subject: "Два" },
        { date: null, from, id: "m3", snippet: null, subject: "Три" },
        { date: null, from: "Друг <friend@example.com>", id: "m4", snippet: null, subject: "Привет" },
      ])),
    });

    const result = await present(gmailRequest("trash", ["m1", "m2", "m3", "m4"]), context());
    const header = result.prompt.split("\n").find((line) => line.startsWith("Отправитель:"))!;

    expect(header).toMatch(/^Отправитель: PayPal <service@paypal\.com> .+… <attacker@evil\.example> — 3 письма$/u);
    expect(result.prompt).toContain("• Друг <friend@example.com> — Привет");
  });

  it("fits a batch of 30 different senders into one Telegram prompt part", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      date: "Mon, 21 Sep 2026 10:00:00 +0300",
      from: `Интернет-магазин электроники номер ${index} <newsletter-${index}@shop-number-${index}.example.com>`,
      id: `m${index}`,
      snippet: null,
      subject: `Персональная подборка товаров со скидкой до 70% только для вас — выпуск ${index}`,
    }));
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox(messages)),
    });

    const result = await present(gmailRequest("trash", messages.map((item) => item.id)), context());

    expect(result.prompt.length).toBeLessThanOrEqual(HITL_PROMPT_CHUNK_CHARACTERS);
    for (let index = 0; index < 30; index += 1) {
      expect(result.prompt).toContain(`• newsletter-${index}@shop-number-${index}.example.com — `);
    }
    expect(result.prompt).toContain("Что произойдёт: Письма будут перемещены в корзину.");
  });

  it("fails closed when Gmail returns metadata for other messages than requested", async () => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn().mockResolvedValue(mailbox([
        { date: null, from: null, id: "m1", snippet: null, subject: null },
      ])),
    });

    await expect(present(gmailRequest("trash", ["m1", "m2"]), context()))
      .rejects.toThrowError(/AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH/u);
  });

  it("shows every material Google Workspace argument", async () => {
    const present = createTelegramApprovalPresenter({
      findProfileProjectionGroup,
      findGroupTitle,
      findGmailMessages: vi.fn(),
    });
    const argv = [
      "gmail",
      "+send",
      "--to",
      "family@example.com",
      "--subject",
      "Семейный план",
      "--body",
      "Встречаемся в 19:00",
    ];

    const result = await present({
      action: {
        callId: "call-gws",
        input: { argv },
        kind: "tool-call",
        toolName: "execute_google_workspace",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gws",
    }, context());

    // Каждый материальный аргумент по-прежнему виден, но читаемыми строками, а не дампом массива.
    expect(result.prompt).toContain("Сервис: Gmail");
    expect(result.prompt).toContain("to: family@example.com");
    expect(result.prompt).toContain("subject: Семейный план");
    expect(result.prompt).toContain("body: Встречаемся в 19:00");
    expect(result.prompt).toContain(`Точная команда: ${argv.join(" ")}`);
    expect(result.prompt).not.toContain(JSON.stringify(argv, null, 2));
    expect(result.prompt).toContain("будет выполнена один раз");
  });

});
