/**
 * Russian Telegram interface tests.
 *
 * Constructs covered:
 * - Approval prompts and buttons hide technical tool names from users.
 * - Freeform prompts and terminal errors use clear Russian text.
 */
import { describe, expect, it } from "vitest";

import {
  formatTelegramSessionFailure,
  formatTelegramTurnFailure,
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
      options: [
        { id: "approve", label: "Yes", style: "primary" as const },
        { id: "deny", label: "No", style: "default" as const },
      ],
      prompt: "Approve tool call: manage_telegram_group",
      requestId: "request-1",
    });

    expect(request.prompt).toBe("Подтвердите действие: подключить Telegram-группу.");
    expect(request.options).toEqual([
      { id: "approve", label: "Да, выполнить", style: "primary" },
      { id: "deny", label: "Нет, отменить", style: "default" },
    ]);
  });

  it("uses a generic Russian prompt for an unknown tool", () => {
    const request = localizeTelegramInputRequest({
      action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "future_tool" },
      display: "confirmation" as const,
      options: [
        { id: "approve", label: "Yes" },
        { id: "deny", label: "No" },
      ],
      prompt: "Approve tool call: future_tool",
      requestId: "request-1",
    });

    expect(request.prompt).toBe("Подтвердите выполнение действия.");
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
      options: [
        { id: "approve", label: "Yes", style: "danger" as const },
        { id: "deny", label: "No" },
      ],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтвердите действие: отключить Telegram-группу и удалить её данные.\n\nTelegram chat ID: -1001",
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
            type: "external_private",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toContain("Название: Рабочая группа");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Разрешённые инструменты: remember");
  });

  it("shows the exact Google Workspace mutation before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "execute",
          command: {
            method: "create",
            resourcePath: ["files"],
            service: "drive",
          },
          upload: { contentType: "application/pdf", path: "report.pdf", scope: "personal" },
        },
        kind: "tool-call" as const,
        toolName: "google_workspace",
      },
      display: "confirmation" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-google",
    });

    expect(request.prompt).toContain("изменить данные в Google Workspace");
    expect(request.prompt).toContain("Сервис: drive");
    expect(request.prompt).toContain("Метод: files.create");
    expect(request.prompt).toContain("Файл: personal/report.pdf");
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

  it("renders safe Russian terminal errors with support references", () => {
    const details = { errorId: "47dae564-7b24-497b-a1b7-69b8fcfdf92c", internal: "secret" };

    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_TOOL_CALL_FAILED",
      details,
    });
    const sessionMessage = formatTelegramSessionFailure({
      code: "AGENT_SESSION_FAILED",
      details,
    });

    expect(turnMessage).toContain("Не удалось выполнить запрос");
    expect(turnMessage).toContain("Код: AGENT_TOOL_CALL_FAILED");
    expect(turnMessage).toContain("Номер ошибки: 47dae564-7b24-497b-a1b7-69b8fcfdf92c");
    expect(sessionMessage).toContain("Не удалось продолжить этот диалог");
    expect(sessionMessage).not.toContain("secret");
  });

});
