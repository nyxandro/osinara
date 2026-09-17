/**
 * Russian Telegram interface tests.
 *
 * Constructs covered:
 * - Approval prompts and buttons hide technical tool names from users.
 * - Policy updates disclose the complete replacement policy and non-disconnection warning.
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

  it("leaves a framework session-limit request unrewritten but localizes its buttons", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { limit: 1_000_000, usedTokens: 1_000_123 },
        kind: "tool-call" as const,
        toolName: "session_limit_continuation",
      },
      display: "confirmation" as const,
      kind: "session-limit" as const,
      options: [
        { id: "continue", label: "Approve" },
        { id: "stop", label: "Stop" },
      ],
      prompt: "Session limit reached",
      requestId: "request-limit",
    });

    // Nothing is executed by a budget prompt, so neither its text nor a consequence may be invented.
    expect(request.prompt).toBe("Session limit reached");
    expect(request.prompt).not.toContain("будет выполнено один раз");
    expect(request.prompt).not.toContain("usedTokens");
    expect(request.options).toEqual([
      { id: "continue", label: "Продолжить" },
      { id: "stop", label: "Остановить" },
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

  it("names a spent model call as an outage and asks to wait", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "MODEL_CALL_FAILED",
      details: { errorId: "47dae564-7b24-497b-a1b7-69b8fcfdf92c" },
    });

    expect(turnMessage).toContain("Нейросеть сейчас недоступна");
    expect(turnMessage).toContain("Попробуйте повторить запрос чуть позже");
    expect(turnMessage).not.toContain("Не удалось выполнить запрос");
    expect(turnMessage).toContain("Код: MODEL_CALL_FAILED");
  });

  it("keeps the support code out of a shared chat", () => {
    const turnMessage = formatTelegramTurnFailure(
      { code: "MODEL_CALL_FAILED", details: { errorId: "47dae564-7b24-497b-a1b7-69b8fcfdf92c" } },
      { includeDiagnostics: false },
    );

    expect(turnMessage).toContain("Нейросеть сейчас недоступна");
    expect(turnMessage).not.toContain("Код:");
    expect(turnMessage).not.toContain("Номер ошибки");
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

    expect(turnMessage).toContain("Нейросеть сейчас недоступна");
    expect(turnMessage).toContain("Код: MODEL_CALL_FAILED");
    expect(turnMessage).toContain("Номер ошибки: 8c4eebf2-a386-4dcb-913d-4b5a28edee2f");
    expect(turnMessage).not.toContain("AGENT_MINIMAX");
    expect(turnMessage).not.toContain("<think>");
    expect(turnMessage).not.toContain("secret reasoning");
  });

});
