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

  it("shows the actionable schedule input explanation without internal details", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_SCHEDULE_INPUT_INVALID",
      message: "AGENT_SCHEDULE_INPUT_INVALID: Для daily recurrence передайте recurrence: {\"kind\":\"daily\",\"interval\":1}",
    });

    expect(turnMessage).toContain("Для daily recurrence передайте recurrence");
    expect(turnMessage).toContain("Код: AGENT_SCHEDULE_INPUT_INVALID");
    expect(turnMessage).not.toContain("stack");
  });

  it("shows actionable input explanations for every validated model payload", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_REMINDER_INPUT_INVALID",
      message: "AGENT_REMINDER_INPUT_INVALID: Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    });

    expect(turnMessage).toContain("Для recurrence передайте null");
    expect(turnMessage).toContain("Код: AGENT_REMINDER_INPUT_INVALID");
  });

  it("keeps generic model failures from exposing internals", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "MODEL_CALL_FAILED",
      details: {
        errorId: "8c4eebf2-a386-4dcb-913d-4b5a28edee2f",
        raw: "<think>secret reasoning</think>",
      },
      message:
        "AGENT_MINIMAX_REASONING_CONTRACT_VIOLATION: Модель вернула внутреннее рассуждение в тексте ответа",
    });

    expect(turnMessage).toContain("Не удалось выполнить запрос");
    expect(turnMessage).toContain("Код: MODEL_CALL_FAILED");
    expect(turnMessage).toContain("Номер ошибки: 8c4eebf2-a386-4dcb-913d-4b5a28edee2f");
    expect(turnMessage).not.toContain("AGENT_MINIMAX");
    expect(turnMessage).not.toContain("<think>");
    expect(turnMessage).not.toContain("secret reasoning");
  });

});
