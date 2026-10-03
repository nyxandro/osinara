/**
 * Owner-managed Telegram group skill policy tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.update_skills` replaces one exact group's safe allowlist after HITL.
 * - Status exposes persisted and globally available safe skills.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listStatuses, updateSkills } = vi.hoisted(() => ({
  listStatuses: vi.fn(),
  updateSkills: vi.fn(),
}));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses,
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    requestGroupSessionRotation: vi.fn(),
    updatePolicy: vi.fn(),
    updateSkills,
  },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

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
    session: { auth: { current: caller, initiator: caller }, id: "session-1" },
  } as unknown as ToolContext;
}

describe("manage_telegram_group.update_skills", () => {
  beforeEach(() => {
    listStatuses.mockReset();
    updateSkills.mockReset();
    updateSkills.mockResolvedValue({ groupId: "group-1", skillsNeedBash: false });
  });

  it("replaces the exact group allowlist with reviewed skills", async () => {
    await expect(manageTelegramGroup.execute({
      action: "update_skills",
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
    }, context())).resolves.toEqual({
      groupId: "group-1",
      skillAllowlist: ["pohuy"],
      skillsUpdated: true,
      takesEffect: "next_group_turn",
      telegramChatId: "-1001234567890",
    });
    expect(updateSkills).toHaveBeenCalledWith({
      familyId: "family-1",
      requestedBy: "owner-1",
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
    });
  });

  it("ignores known sibling fields materialized by the model transport", async () => {
    await expect(manageTelegramGroup.execute({
      action: "update_skills",
      messageMode: "all",
      registration: {
        messageMode: "all",
        telegramChatId: "-1009999999999",
        title: "Не используется",
        toolAllowlist: [],
        type: "external",
      },
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
      toolAllowlist: ["remember"],
    }, context())).resolves.toMatchObject({
      skillAllowlist: ["pohuy"],
      skillsUpdated: true,
    });
    expect(updateSkills).toHaveBeenCalledWith(expect.objectContaining({
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
    }));
  });

  // Whether a well-formed name is an existing skill is decided by the repository, which also knows
  // the family's own skills (`family-skills.integration.test.ts`).
  it("rejects malformed and duplicate skill names before persistence", async () => {
    await expect(manageTelegramGroup.execute({
      action: "update_skills",
      skillAllowlist: ["../escape"],
      telegramChatId: "-1001234567890",
    } as never, context())).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID.*availableSafeSkills/u);
    await expect(manageTelegramGroup.execute({
      action: "update_skills",
      skillAllowlist: ["pohuy", "pohuy"],
      telegramChatId: "-1001234567890",
    }, context())).rejects.toThrowError(/не должен содержать повторы/u);
    expect(updateSkills).not.toHaveBeenCalled();
  });
});
