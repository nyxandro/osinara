/**
 * Owner-requested Telegram group context rotation tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.start_new_context`: requests all-topic canonical rotation without HITL.
 * - Private prompt guidance: resolves the exact registered chat before mutation.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestGroupSessionRotation } = vi.hoisted(() => ({
  requestGroupSessionRotation: vi.fn(),
}));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses: vi.fn(),
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    requestGroupSessionRotation,
    updatePolicy: vi.fn(),
  },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";
import { modeInstructions } from "./prompt/mode-instructions.js";

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

describe("manage_telegram_group.start_new_context", () => {
  beforeEach(() => {
    requestGroupSessionRotation.mockReset();
    requestGroupSessionRotation.mockResolvedValue({
      groupId: "group-1",
      requestedCanonicalSessions: 2,
    });
  });

  it("requests a fresh canonical context for every topic of the exact family group", async () => {
    await expect(manageTelegramGroup.execute({
      action: "start_new_context",
      telegramChatId: "-1001234567890",
    }, context())).resolves.toEqual({
      groupId: "group-1",
      newContextStartsWithNextMessage: true,
      pendingTasksPreserved: true,
      requestedCanonicalSessions: 2,
      scope: "all_topics",
      telegramChatId: "-1001234567890",
    });
    expect(requestGroupSessionRotation).toHaveBeenCalledWith({
      familyId: "family-1",
      requestedBy: "owner-1",
      telegramChatId: "-1001234567890",
    });
  });

  it("does not require HITL for a non-destructive context rotation", () => {
    expect(approvalFor({
      action: "start_new_context",
      telegramChatId: "-1001234567890",
    })).toBe("not-applicable");
  });

  it("ignores known fields that MiniMax materializes beside the exact rotation target", async () => {
    await expect(manageTelegramGroup.execute({
      action: "start_new_context",
      messageMode: "owner_only",
      registration: {
        messageMode: "all",
        telegramChatId: "-1009999999999",
        title: "Не используется",
        toolAllowlist: [],
        type: "external",
      },
      telegramChatId: "-1001234567890",
      toolAllowlist: ["search_memories"],
    }, context())).resolves.toMatchObject({
      newContextStartsWithNextMessage: true,
      telegramChatId: "-1001234567890",
    });
    expect(requestGroupSessionRotation).toHaveBeenCalledWith(expect.objectContaining({
      telegramChatId: "-1001234567890",
    }));
  });

  it("returns a corrective status-first instruction instead of inviting a chat ID guess", async () => {
    await expect(manageTelegramGroup.execute({
      action: "start_new_context",
      telegramChatId: "Остриков пилит агентов",
    }, context())).rejects.toThrowError(
      /Не угадывайте ID.*\{"action":"status"\}.*\{"action":"start_new_context","telegramChatId":"-100/u,
    );
    expect(requestGroupSessionRotation).not.toHaveBeenCalled();
  });

  it("instructs the model to resolve the registered chat before rotating it", () => {
    const instructions = modeInstructions({ environment: "private" });

    expect(instructions).toContain('`{"action":"status"}`');
    expect(instructions).toContain("сначала вызови `status`");
    expect(instructions).toContain("скопируй `startNewContextInput`");
    expect(instructions).toContain("не заполняй optional-поля других actions");
    expect(instructions).toContain("всех forum-тем");
    expect(instructions).toContain("Если запрос указывает другую группу, не вызывай `start_new_context`");
  });
});
