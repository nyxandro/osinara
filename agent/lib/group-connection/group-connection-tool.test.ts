/**
 * Disconnection and reconnection through `manage_telegram_group` (#465).
 *
 * Constructs covered:
 * - `disconnect` and `reconnect` reach the connection actions with the verified owner and their chat.
 * - Both ask the owner's button; a schedule or a delegated task gets neither them nor `remove`.
 * - A malformed chat id is refused before anything changes.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { disconnect, reconnect } = vi.hoisted(() => ({ disconnect: vi.fn(), reconnect: vi.fn() }));

vi.mock("./group-connection-actions.js", () => ({ groupConnectionActions: { disconnect, reconnect } }));

import manageTelegramGroup from "../tools/manage_telegram_group.js";

function context(options: { parent?: boolean; scheduled?: boolean } = {}): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      ...(options.scheduled ? { scheduledRunId: "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" } : {}),
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
      ...(options.parent ? { parent: { id: "parent-session" } } : {}),
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function approval(input: Record<string, unknown>, ctx: ToolContext): unknown {
  return (manageTelegramGroup.approval as (context: unknown) => unknown)({ ...ctx, toolInput: input });
}

describe("manage_telegram_group disconnect and reconnect", () => {
  beforeEach(() => {
    disconnect.mockReset().mockResolvedValue({ status: "disconnected" });
    reconnect.mockReset().mockResolvedValue({ status: "reconnected" });
  });

  it("disconnects and reconnects for the verified owner, from their own chat", async () => {
    const request = { familyId: "family-1", ownerTelegramChatId: "101", requestedBy: "owner-1", telegramChatId: "-1001" };

    await expect(manageTelegramGroup.execute({ action: "disconnect", telegramChatId: "-1001" }, context()))
      .resolves.toEqual({ status: "disconnected" });
    await expect(manageTelegramGroup.execute({ action: "reconnect", telegramChatId: "-1001" }, context()))
      .resolves.toEqual({ status: "reconnected" });

    expect(disconnect).toHaveBeenCalledWith(request);
    expect(reconnect).toHaveBeenCalledWith(request);
  });

  it("asks the owner's button for both", () => {
    expect(approval({ action: "disconnect", telegramChatId: "-1001" }, context())).toBe("user-approval");
    expect(approval({ action: "reconnect", telegramChatId: "-1001" }, context())).toBe("user-approval");
  });

  it.each([
    ["a schedule", { scheduled: true }],
    ["a delegated task", { parent: true }],
  ])("refuses %s to disconnect, reconnect or remove a group", async (_case, options) => {
    for (const action of ["disconnect", "reconnect", "remove"] as const) {
      expect(approval({ action, telegramChatId: "-1001" }, context(options)))
        .toMatchObject({ reason: expect.stringContaining("AGENT_GROUP_CHANGE_NOT_SCHEDULED"), type: "denied" });
      await expect(manageTelegramGroup.execute({ action, telegramChatId: "-1001" }, context(options)))
        .rejects.toMatchObject({ code: "AGENT_GROUP_CHANGE_NOT_SCHEDULED" });
    }
    expect(disconnect).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("refuses a malformed chat id before anything changes", async () => {
    await expect(manageTelegramGroup.execute({ action: "disconnect", telegramChatId: "1001" }, context()))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_GROUP_INPUT_INVALID" });
    expect(disconnect).not.toHaveBeenCalled();
  });
});
