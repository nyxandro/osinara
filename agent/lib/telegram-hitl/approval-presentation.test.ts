/**
 * Semantic Telegram approval presentation tests.
 *
 * Constructs covered:
 * - Group policy approvals name the exact proposed mode and the executable dependencies.
 * - The prompt explains the exact consequence before a decision is requested.
 * - A Google Workspace access grant exposes the complete exact argv.
 * - An API key grant names the stored key, its service and the live group title, not model words.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramApprovalPresenter } from "./approval-presentation.js";
import { API_KEY_GRANT_CONSEQUENCE, GROUP_TOOLS_NO_BASH_CONSEQUENCE } from "./approval-consequences.js";
import type { TelegramInputRequest } from "../telegram-interface.js";

// No card here changes a group automation unless it sets its own lookup. Skill changes have no
// cards at all: they need no confirmation.
const SKILL_DEPENDENCIES = {
  findApiKey: vi.fn(),
  findExternalSchedule: vi.fn(),
};

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

function automationRequest(input: TelegramInputRequest["action"]["input"]) {
  return {
    action: { callId: "call-automation", input, kind: "tool-call" as const, toolName: "manage_external_group_schedule" },
    kind: "tool-approval" as const,
    options: [{ id: "approve", label: "Yes", style: "primary" as const }, { id: "cancel", label: "No", style: "default" as const }],
    prompt: "Approve tool call",
    requestId: "request-automation",
  };
}

describe("group automation approval presentation", () => {
  it("names the automation and the group an update changes", async () => {
    const findExternalSchedule = vi.fn().mockResolvedValue({
      telegramChatId: "-1001", telegramGroupTitle: "Разработчики", title: "Недельная выжимка",
    });
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES, findExternalSchedule,
      findGroupTitle, findProfileProjectionGroup });

    const request = await present(automationRequest({
      action: "update", id: "00000000-0000-4000-8000-000000000001", maxRuns: null,
    }), context());

    expect(findExternalSchedule).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", expect.anything());
    expect(request.prompt).toContain("Подтверждение: изменить автоматизацию, публикующую результат во внешнюю Telegram-группу.");
    expect(request.prompt).toContain("Автоматизация: Недельная выжимка");
    expect(request.prompt).toContain("Группа: Разработчики (-1001)");
    expect(request.prompt).toContain("Число запусков: без ограничения");
    expect(request.prompt).not.toContain("manage_external_group_schedule");
  });

  it("names the group a new automation will publish into", async () => {
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES,
      findGroupTitle, findProfileProjectionGroup });

    const request = await present(automationRequest({
      action: "create", capabilityAllowlist: [], firstRunAt: "2026-10-20T09:00:00+03:00", recurrence: { kind: "once" },
      scenarioPrompt: "Проверь сайт", telegramChatId: "-1001", timezone: "Europe/Moscow", title: "Проверка",
      userRequest: "Проверь сайт завтра",
    }), context());

    expect(request.prompt).toContain("Группа: Тестовая группа (-1001)");
    expect(request.prompt).toContain("Название: Проверка");
    expect(request.prompt).toContain("Повторение: однократно");
    expect(request.prompt).toContain("Дополнительные инструменты: нет");
  });

  it("refuses to show a card for a group outside the family", async () => {
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES,
      findGroupTitle: vi.fn().mockResolvedValue(null), findProfileProjectionGroup });

    await expect(present(automationRequest({
      action: "create", capabilityAllowlist: [], firstRunAt: "2026-10-20T09:00:00+03:00", recurrence: { kind: "once" },
      scenarioPrompt: "x", telegramChatId: "-1009", timezone: "Europe/Moscow", title: "x", userRequest: "x",
    }), context())).rejects.toMatchObject({ code: "AGENT_APPROVAL_GROUP_NOT_FOUND" });
  });
});

describe("Telegram approval presentation", () => {
  it("shows an API key grant with the stored service and the group's own title", async () => {
    const findApiKey = vi.fn().mockResolvedValue({
      authHeader: "authorization", authScheme: "bearer", name: "neuraldeep",
      purpose: "генерация картинок", upstreamBaseUrl: "https://api.neuraldeep.ru/v1",
    });
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES, findApiKey, findProfileProjectionGroup, findGroupTitle });

    const result = await present({
      action: { callId: "key-call", kind: "tool-call", toolName: "manage_api_keys",
        input: { action: "grant", name: "neuraldeep", target: "group", telegramChatId: "-100123" } },
      kind: "tool-approval" as const,
      prompt: "Approval", requestId: "key-request",
      options: [{ id: "approve", label: "Yes", style: "primary" }],
    }, context());

    expect(findApiKey).toHaveBeenCalledWith("neuraldeep", expect.anything());
    expect(result.prompt).toContain("Ключ: neuraldeep — генерация картинок");
    expect(result.prompt).toContain("Сервис: https://api.neuraldeep.ru/v1");
    expect(result.prompt).toContain("Кому: внешняя группа «Тестовая группа» (-100123)");
    expect(result.prompt).toContain(API_KEY_GRANT_CONSEQUENCE);
  });

  it.each([
    ["owner_only", "Запуск только по обращению владельца; контекст всех сообщений (owner_only)"],
    ["addressed_only", "Запуск по обращению любого участника; контекст всех сообщений (addressed_only)"],
    ["all", "Запуск по обращению любого участника; контекст всех сообщений (all)"],
  ])("shows the exact proposed message mode %s", async (messageMode, explanation) => {
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES, findProfileProjectionGroup, findGroupTitle });
    const result = await present({
      action: { callId: "group-call", kind: "tool-call", toolName: "manage_telegram_group",
        input: { action: "update_policy", telegramChatId: "-100123", messageMode, toolAllowlist: [] } },
      kind: "tool-approval" as const,
      prompt: "Approval", requestId: "group-request",
      options: [{ id: "approve", label: "Yes", style: "primary" }],
    }, context());
    expect(result.prompt).toContain(`Режим сообщений: ${explanation}`);
  });
  it("shows the revocation of executable dependencies from the exact group input", async () => {
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES, findProfileProjectionGroup, findGroupTitle });
    for (const [input, consequence] of [
      [{ action: "update_policy", telegramChatId: "-100123", messageMode: "all", toolAllowlist: [] }, GROUP_TOOLS_NO_BASH_CONSEQUENCE],
    ] as const) {
      const result = await present({
        action: { callId: "group-call", kind: "tool-call", toolName: "manage_telegram_group", input },
        kind: "tool-approval" as const,
        prompt: "No permission changes", requestId: "group-request",
        options: [{ id: "approve", label: "Yes", style: "primary" }],
      }, context());
      expect(result.prompt).toContain(consequence);
      expect(result.prompt).toContain("-100123");
      expect(result.prompt).not.toContain("No permission changes");
    }
  });

  it("shows every material argument of a Google Workspace access grant", async () => {
    const present = createTelegramApprovalPresenter({ ...SKILL_DEPENDENCIES,
      findProfileProjectionGroup,
      findGroupTitle,
    });
    const argv = [
      "gmail",
      "users",
      "settings",
      "updateAutoForwarding",
      "--params",
      '{"userId":"me"}',
      "--json",
      '{"enabled":true,"emailAddress":"someone@example.com","disposition":"leaveInInbox"}',
    ];

    const result = await present({
      action: {
        callId: "call-gws",
        input: { argv },
        kind: "tool-call",
        toolName: "execute_google_workspace",
      },
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gws",
    }, context());

    // Каждый материальный аргумент по-прежнему виден, но читаемыми строками, а не дампом массива.
    expect(result.prompt).toContain("Подтверждение: открытие доступа к данным Google.");
    expect(result.prompt).toContain("Сервис: Gmail");
    expect(result.prompt).toContain("Команда: users settings updateAutoForwarding");
    expect(result.prompt).toContain(`Точная команда: ${argv.join(" ")}`);
    expect(result.prompt).not.toContain(JSON.stringify(argv, null, 2));
    expect(result.prompt).toContain("будет выполнена один раз");
  });

});
