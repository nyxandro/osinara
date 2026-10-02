/**
 * Telegram group status tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.status` reads every family registration without HITL.
 * - Destructive/policy actions retain approval while context rotation remains non-destructive.
 * - External status distinguishes configured grants from always-available workspace tools.
 * - Private-mode guidance requires reading status before an uncertain policy replacement.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listStatuses } = vi.hoisted(() => ({ listStatuses: vi.fn() }));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses,
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    updatePolicy: vi.fn(),
  },
}));

vi.mock("./family-skills/family-skill-repository.js", () => ({
  familySkillRepository: { grantableSkills: vi.fn().mockResolvedValue(new Map()) },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";
import { modeInstructions } from "./prompt/mode-instructions.js";
import { GROUP_SAFE_SKILL_NAMES } from "./group-skills/group-skill-catalog.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: "101",
      telegramChatType: "private",
    },
    authenticator: "telegram",
    principalId: "owner-1",
    principalType: "user" as const,
  };
  return {
    session: {
      auth: { current: caller, initiator: caller },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function approvalFor(input: Record<string, unknown>) {
  const approval = (manageTelegramGroup as unknown as {
    approval: (context: { toolInput: Record<string, unknown> }) => unknown;
  }).approval;
  return approval({ toolInput: input });
}

describe("manage_telegram_group.status", () => {
  beforeEach(() => {
    listStatuses.mockReset();
    listStatuses.mockResolvedValue([
      {
        messageMode: "owner_only",
        skillAllowlist: ["pohuy"],
        telegramChatId: "-1002",
        title: "Внешняя",
        toolAllowlist: ["search_memories"],
        type: "external",
      },
      {
        messageMode: "all",
        skillAllowlist: [],
        telegramChatId: "-1001",
        title: "Семья",
        toolAllowlist: [],
        type: "family_private",
      },
    ]);
  });

  it("returns every configured policy in one read-only result", async () => {
    await expect(manageTelegramGroup.execute({ action: "status" }, context())).resolves.toEqual({
      availableSafeSkills: [...GROUP_SAFE_SKILL_NAMES],
      skillRequirements: expect.objectContaining({
        "agent-browser": { tools: ["bash"] },
        pohuy: { tools: [] },
        "t-invest": { tools: ["bash"], connectionRequired: true, externalConnectionAvailable: false },
        "gws-gmail": { tools: [], connectionRequired: true, externalConnectionAvailable: false },
      }),
      groups: [
        expect.objectContaining({
          builtInWorkspaceTools: ["glob", "grep", "read_file", "write_file"],
          alwaysAvailableTools: ["glob", "grep", "read_file", "write_file", "web_search", "web_fetch", "get_current_time", "todo", "agent"],
          effectiveConfiguredTools: ["glob", "grep", "read_file", "write_file", "web_search", "web_fetch", "get_current_time", "todo", "agent", "search_memories"],
          effectiveSkills: ["pohuy"],
          policySummary: "Базовые workspace tools плюс полный настроенный allowlist внешней группы.",
          toolAccessMode: "external_allowlist",
          toolAllowlist: ["search_memories"],
          startNewContextInput: {
            action: "start_new_context",
            telegramChatId: "-1002",
          },
        }),
        expect.objectContaining({
          builtInWorkspaceTools: [],
          effectiveSkills: [...GROUP_SAFE_SKILL_NAMES],
          policySummary: "Инструменты назначаются семейным режимом; отдельный allowlist не настраивается.",
          toolAccessMode: "family_policy",
          toolAllowlist: [],
          startNewContextInput: {
            action: "start_new_context",
            telegramChatId: "-1001",
          },
        }),
      ],
      total: 2,
    });
    expect(listStatuses).toHaveBeenCalledWith({ familyId: "family-1", requestedBy: "owner-1" });
  });

  it("ignores known fields that MiniMax materializes for another action", async () => {
    await expect(manageTelegramGroup.execute({
      action: "status",
      messageMode: "all",
      registration: {
        messageMode: "addressed_only",
        telegramChatId: "-1009999999999",
        title: "Не используется",
        toolAllowlist: [],
        type: "external",
      },
      telegramChatId: "-1009999999999",
      toolAllowlist: ["search_memories"],
    }, context())).resolves.toMatchObject({ total: 2 });
    expect(listStatuses).toHaveBeenCalledTimes(1);
  });

  it("still rejects fields outside the published shared schema", async () => {
    await expect(manageTelegramGroup.execute({
      action: "status",
      telegramChat: "-1001",
    } as never, context())).rejects.toThrowError(
      /AGENT_TELEGRAM_GROUP_INPUT_INVALID.*telegramChat.*telegramChatId/u,
    );
    expect(listStatuses).not.toHaveBeenCalled();
  });

  it("skips HITL only for read-only status and non-destructive context rotation", () => {
    expect(approvalFor({ action: "status" })).toBe("not-applicable");
    expect(approvalFor({ action: "start_new_context", telegramChatId: "-1001" })).toBe("not-applicable");
    expect(approvalFor({
      action: "update_policy",
      messageMode: "all",
      telegramChatId: "-1001",
      toolAllowlist: [],
    })).toBe("user-approval");
    expect(approvalFor({
      action: "update_skills",
      skillAllowlist: [],
      telegramChatId: "-1001",
    })).toBe("user-approval");
    expect(approvalFor({ action: "remove", telegramChatId: "-1001" })).toBe("user-approval");
    expect(approvalFor({
      action: "register",
      registration: {
        messageMode: "all",
        telegramChatId: "-1001",
        title: "Семья",
        type: "family_private",
      },
    })).toBe("user-approval");
  });

  it("requires status before replacing an unknown current policy", () => {
    const instructions = modeInstructions({ environment: "private" });

    expect(instructions).toContain("Перед `update_policy` или `update_skills` сначала вызови");
    expect(instructions).toContain("`{\"action\":\"status\"}`");
    expect(instructions).toContain("команду `/status`");
    expect(instructions).toContain("одним сообщением");
  });
});
