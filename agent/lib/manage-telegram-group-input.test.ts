/**
 * Telegram group administration model-input contract tests.
 *
 * Constructs covered:
 * - Machine-visible required action enum in an object-shaped schema.
 * - One semantic parser rejects invalid actions before HITL and execution.
 * - Known MiniMax sibling fields remain inert while unpublished fields fail closed.
 * - Mutation results expose the complete applied registration, policy, or allowlist.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const repositories = vi.hoisted(() => ({
  listStatuses: vi.fn(),
  registerGroup: vi.fn(),
  removeRegistration: vi.fn(),
  requestGroupSessionRotation: vi.fn(),
  updatePolicy: vi.fn(),
  updateSkills: vi.fn(),
}));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: repositories,
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

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
const context = {
  session: { auth: { current: caller, initiator: caller }, id: "session-1" },
} as unknown as ToolContext;

function approvalFor(input: Record<string, unknown>) {
  return (manageTelegramGroup.approval as (context: never) => unknown)(
    { toolInput: input } as never,
  );
}

describe("manage_telegram_group model input", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repositories.listStatuses.mockResolvedValue([]);
    repositories.registerGroup.mockResolvedValue({ groupId: "group-1" });
    repositories.removeRegistration.mockResolvedValue({ groupId: "group-1" });
    repositories.requestGroupSessionRotation.mockResolvedValue({
      groupId: "group-1",
      requestedCanonicalSessions: 0,
    });
    repositories.updatePolicy.mockResolvedValue({ groupId: "group-1" });
    repositories.updateSkills.mockResolvedValue({ groupId: "group-1" });
  });

  it("publishes a required finite action enum in an object schema", () => {
    const schema = z.toJSONSchema(manageTelegramGroup.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    expect(schema.properties.action?.enum).toEqual([
      "register",
      "remove",
      "start_new_context",
      "status",
      "update_policy",
      "update_skills",
    ]);
  });

  it.each([
    [{ action: "register", registration: { type: "external" } }, /registration\.telegramChatId/u],
    [{ action: "remove" }, /telegramChatId/u],
    [{ action: "start_new_context" }, /telegramChatId/u],
    [{ action: "update_policy", telegramChatId: "-1001" }, /messageMode/u],
    [{ action: "update_skills", telegramChatId: "-1001" }, /skillAllowlist/u],
  ])("rejects the same invalid action before HITL and execution", async (invalid, message) => {
    expect(() => approvalFor(invalid)).toThrowError(message);
    await expect(manageTelegramGroup.execute(invalid as never, context)).rejects.toThrowError(message);
  });

  it("keeps valid status and context rotation outside HITL", () => {
    expect(approvalFor({ action: "status" })).toBe("not-applicable");
    expect(approvalFor({
      action: "start_new_context",
      telegramChatId: "-1001234567890",
    })).toBe("not-applicable");
  });

  it("ignores only published MiniMax siblings and rejects unpublished fields before HITL", () => {
    expect(approvalFor({
      action: "remove",
      messageMode: "all",
      registration: {},
      skillAllowlist: [],
      telegramChatId: "-1001234567890",
      toolAllowlist: [],
    })).toBe("user-approval");
    expect(() => approvalFor({
      action: "remove",
      telegramChat: "-1001234567890",
      telegramChatId: "-1001234567890",
    })).toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID.*telegramChat/u);
  });

  it("returns complete applied registration and replacement policies", async () => {
    await expect(manageTelegramGroup.execute({
      action: "register",
      registration: {
        messageMode: "owner_only",
        telegramChatId: "-1001234567890",
        title: "Внешняя",
        toolAllowlist: ["search_memories"],
        type: "external",
      },
    }, context)).resolves.toMatchObject({
      groupId: "group-1",
      messageMode: "owner_only",
      telegramChatId: "-1001234567890",
      title: "Внешняя",
      toolAllowlist: ["search_memories"],
      type: "external",
    });
    await expect(manageTelegramGroup.execute({
      action: "update_policy",
      messageMode: "all",
      telegramChatId: "-1001234567890",
      toolAllowlist: ["search_memories"],
    }, context)).resolves.toMatchObject({
      messageMode: "all",
      toolAllowlist: ["search_memories"],
    });
    await expect(manageTelegramGroup.execute({
      action: "update_skills",
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
    }, context)).resolves.toMatchObject({ skillAllowlist: ["pohuy"] });
    await expect(manageTelegramGroup.execute({
      action: "remove",
      telegramChatId: "-1001234567890",
    }, context)).resolves.toMatchObject({ groupId: "group-1" });
  });

  it("documents exact action payloads and leaves finite enums to the schema", () => {
    for (const fragment of [
      '{"action":"status"}',
      "остальные actions только плоские поля",
      "никогда не угадывай telegramChatId",
      "не более одного раза",
    ]) expect(manageTelegramGroup.description).toContain(fragment);
    // Перечисления модель получает из JSON-схемы; дублировать их прозой значит платить дважды.
    const schema = JSON.stringify(z.toJSONSchema(manageTelegramGroup.inputSchema as z.ZodType));
    for (const value of ["addressed_only", "owner_only", "family_private", "external"]) {
      expect(schema).toContain(value);
    }
  });
});
