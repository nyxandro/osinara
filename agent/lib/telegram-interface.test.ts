/**
 * Russian Telegram interface tests.
 *
 * Constructs covered:
 * - Approval prompts and buttons hide technical tool names from users.
 * - Policy updates disclose the complete replacement policy and non-disconnection warning.
 * - Freeform prompts use clear Russian text.
 */
import { describe, expect, it } from "vitest";

import {
  localizeTelegramInputRequest,
  localizeTelegramReplyMarkup,
} from "./telegram-interface.js";

describe("Telegram interface localization", () => {
  it("localizes a known tool approval without changing response identifiers", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { action: "register" },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes", style: "primary" as const },
        { id: "cancel", label: "No", style: "default" as const },
      ],
      prompt: "Approve tool call: manage_telegram_group",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: подключить Telegram-группу. Если чат уже подключён с другим типом, его история, workspace, память и сессии будут безвозвратно удалены.\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.options).toEqual([
      { id: "approve", label: "Да, подтвердить", style: "primary" },
      { id: "cancel", label: "Нет, отменить", style: "default" },
    ]);
  });

  it("describes the external group file removal that only exists outside the tools directory", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { path: "notes/plan.md" },
        kind: "tool-call" as const,
        toolName: "remove_group_file",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: remove_group_file",
      requestId: "request-file",
    });

    // Единственный разрушительный инструмент внешней группы живёт вне agent/lib/tools/,
    // поэтому его окно проверяется явно.
    expect(request.prompt).toBe(
      "Подтверждение: удалить файл внешней группы.\n\nПуть: notes/plan.md\n\n" +
        "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.options).toEqual([
      { id: "approve", label: "Да, подтвердить" },
      { id: "cancel", label: "Нет, отменить" },
    ]);
  });

  it("uses a generic Russian prompt for an unknown tool", () => {
    const request = localizeTelegramInputRequest({
      action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "future_tool" },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: future_tool",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: выполнение действия.\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.prompt).not.toContain("future_tool");
  });

  it("localizes Telegram group removal as a destructive approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { action: "remove", telegramChatId: "-1001" },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes", style: "danger" as const },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: удалить регистрацию Telegram-группы и связанные данные Osinara. Бот останется участником Telegram-чата.\n\nTelegram chat ID: -1001\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
  });

  it("shows exact group registration parameters before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "register",
          registration: {
            messageMode: "all",
            telegramChatId: "-1001",
            title: "Рабочая группа",
            toolAllowlist: ["remember"],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toContain("Название: Рабочая группа");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Разрешённые инструменты: remember");
    expect(request.prompt).toContain("история, workspace, память и сессии будут безвозвратно удалены");
  });

  it("shows what a new group automation will publish before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "create",
          capabilityAllowlist: ["send_workspace_file"],
          firstRunAt: "2026-10-20T09:00:00+03:00",
          historyWindowDays: 7,
          maxRuns: null,
          recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
          scenarioPrompt: "Собери выжимку обсуждения за неделю и пришли HTML-файлом.",
          telegramChatId: "-1001",
          timezone: "Europe/Moscow",
          title: "Недельная выжимка",
          userRequest: "Каждый понедельник присылай выжимку",
        },
        kind: "tool-call" as const,
        toolName: "manage_external_group_schedule",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toContain("публиковать результат во внешнюю Telegram-группу");
    expect(request.prompt).toContain("Название: Недельная выжимка");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Первый запуск: 2026-10-20T09:00:00+03:00 (Europe/Moscow)");
    expect(request.prompt).toContain("Повторение: каждую неделю по дням: пн");
    expect(request.prompt).toContain("Исходная просьба: Каждый понедельник присылай выжимку");
    expect(request.prompt).toContain("Число запусков: без ограничения");
    expect(request.prompt).toContain("Сценарий: Собери выжимку обсуждения за неделю и пришли HTML-файлом.");
    expect(request.prompt).toContain("Дополнительные инструменты: send_workspace_file");
    expect(request.prompt).toContain("История группы: за 7 дн.");
    expect(request.prompt).not.toContain("manage_external_group_schedule");
  });

  it("shows only the fields a group automation update changes", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "update", historyWindowDays: null, id: "00000000-0000-4000-8000-000000000001",
          recurrence: { interval: 3, kind: "hourly" }, scenarioPrompt: "Теперь только итоги", userRequest: "Опубликуй дословно",
        },
        kind: "tool-call" as const,
        toolName: "manage_external_group_schedule",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toContain("изменить автоматизацию");
    expect(request.prompt).toContain("Сценарий: Теперь только итоги");
    // The run receives userRequest as the person's own request, so a changed one is always shown.
    expect(request.prompt).toContain("Исходная просьба: Опубликуй дословно");
    expect(request.prompt).toContain("Повторение: раз в 3 часа");
    expect(request.prompt).toContain("История группы: не читается");
    expect(request.prompt).not.toContain("Название:");
  });

  it("escapes control characters in model-provided approval values", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-hostile-title",
        input: {
          action: "register",
          registration: {
            messageMode: "all",
            telegramChatId: "-1001",
            title: "Рабочая\nTelegram chat ID: -100999",
            toolAllowlist: [],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-hostile-title",
    });

    expect(request.prompt).toContain("Название: Рабочая\\nTelegram chat ID: -100999");
    expect(request.prompt).not.toContain("Название: Рабочая\nTelegram chat ID: -100999");
  });

  it("shows the complete policy replacement and warns that the group stays connected", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-policy",
        input: {
          action: "update_policy",
          messageMode: "owner_only",
          telegramChatId: "-1001",
          toolAllowlist: ["remember", "list_group_history"],
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-policy",
    });

    expect(request.prompt).toContain("изменить политику внешней Telegram-группы");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Режим сообщений: owner_only");
    expect(request.prompt).toContain("Полный список разрешённых инструментов: remember, list_group_history");
    expect(request.prompt).toContain("Группа и бот останутся подключены");
  });

  it("shows the complete skill replacement including revoking every skill", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-skills",
        input: { action: "update_skills", skillAllowlist: [], telegramChatId: "-1001" },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-skills",
    });

    expect(request.prompt).toContain("изменить список skills внешней Telegram-группы");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Полный список разрешённых skills: пуст");
  });

  it("shows an explicitly empty tool policy during external registration", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-register-empty",
        input: {
          action: "register",
          registration: {
            messageMode: "addressed_only",
            telegramChatId: "-1001",
            title: "Изолированная группа",
            toolAllowlist: [],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-register-empty",
    });

    expect(request.prompt).toContain("Разрешённые инструменты: пуст");
  });

  it("localizes removal of a workspace Google profile", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "disconnect",
        },
        kind: "tool-call" as const,
        toolName: "manage_google_workspace_connection",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-google",
    });

    expect(request.prompt).toContain("отключить Google Workspace от текущей области");
  });

  it("localizes the freeform answer placeholder", () => {
    expect(
      localizeTelegramReplyMarkup({
        force_reply: true,
        input_field_placeholder: "Type your answer",
        selective: true,
      }),
    ).toEqual({
      force_reply: true,
      input_field_placeholder: "Введите ответ",
      selective: true,
    });
  });
});
