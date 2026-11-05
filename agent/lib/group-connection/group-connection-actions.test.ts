/**
 * The owner's disconnection and reconnection of an external group (#465).
 *
 * Constructs covered:
 * - Disconnection changes the state, republishes keys, stops the group's sandboxes and sends the owner
 *   the application's confirmation; the model is told not to repeat it.
 * - A failure after the change is logged and never undoes it; an unsent confirmation is handed to the
 *   model to pass on.
 * - A repeated request changes nothing and sends nothing.
 * - Reconnection refuses while the bot is not in the group and asks Telegram nothing for a connected one.
 * - Removal deletes the chat's raw copies before and after the registration, stops the sandboxes after
 *   the commit, and never touches a chat the family does not have (#464).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { isAppError } from "../app-error.js";
import { createGroupConnectionActions, type GroupConnectionActionDependencies } from "./group-connection-actions.js";

const REQUEST = { familyId: "family-1", ownerTelegramChatId: "101", requestedBy: "owner-1", telegramChatId: "-1001" };
const GROUP = { groupId: "group-1", telegramChatId: "-1001", title: "Внешняя группа" };

function setup() {
  const dependencies = {
    publishApiKeys: vi.fn(async () => undefined),
    purgeIngressCopies: vi.fn(async (_telegramChatId: string) => 3),
    removeRegistration: vi.fn(async (_input: unknown) => ({ groupId: "group-1", sandboxThreadIds: ["thread-1"], title: "Внешняя группа" })),
    stopSandboxThreads: vi.fn(async (_threadIds: readonly string[]) => undefined),
    repository: {
      disconnect: vi.fn(async () => ({ ...GROUP, status: "disconnected" as const })),
      find: vi.fn(async () => ({ ...GROUP, disconnectedAt: new Date("2026-11-04T10:00:00Z"), type: "external" })),
      reconnect: vi.fn(async () => ({
        ...GROUP, disconnectedAt: new Date("2026-11-04T10:00:00Z"), reconnectedAt: new Date("2026-12-02T10:00:00Z"), status: "reconnected" as const,
      })),
    },
    stopSandboxes: vi.fn(async () => undefined),
    telegram: {
      botIsMember: vi.fn(async (_telegramChatId: string) => true),
      sendToOwner: vi.fn(async (_ownerTelegramChatId: string, _text: string) => undefined),
    },
  };
  return { actions: createGroupConnectionActions(dependencies as unknown as GroupConnectionActionDependencies), dependencies };
}

afterEach(() => vi.restoreAllMocks());

describe("disconnect", () => {
  it("stops the group's work and sends the owner the application's confirmation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { actions, dependencies } = setup();

    const result = await actions.disconnect(REQUEST);

    expect(dependencies.repository.disconnect).toHaveBeenCalledWith(REQUEST);
    expect(dependencies.publishApiKeys).toHaveBeenCalledTimes(1);
    expect(dependencies.stopSandboxes).toHaveBeenCalledWith("group-1");
    const [chatId, notice] = dependencies.telegram.sendToOwner.mock.calls[0]!;
    expect(chatId).toBe("101");
    expect(notice).toContain("«Внешняя группа» отключена");
    expect(notice).toContain("с этого момента не обновляются");
    expect(notice).toContain("запись возобновится с момента подключения");
    expect(notice).toContain("навсегда, без возможности восстановления");
    expect(result).toMatchObject({ ownerNotified: true, status: "disconnected", title: "Внешняя группа" });
    expect(result.nextStep).toContain(EMPTY_DELIVERY_MARKER);
  });

  it("keeps the change when keys, sandboxes or the confirmation fail, and hands the confirmation to the model", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { actions, dependencies } = setup();
    dependencies.publishApiKeys.mockRejectedValue(new Error("disk full"));
    dependencies.stopSandboxes.mockRejectedValue(new Error("runner down"));
    dependencies.telegram.sendToOwner.mockRejectedValue(new Error("HTTP 502"));

    const result = await actions.disconnect(REQUEST);

    expect(result).toMatchObject({ ownerNotified: false, status: "disconnected" });
    expect(result.nextStep).toContain("no longer updated");
    expect(result.nextStep).not.toContain(EMPTY_DELIVERY_MARKER);
    const codes = errors.mock.calls.map(([line]) => (JSON.parse(String(line)) as { code: string }).code);
    expect(codes).toEqual(["AGENT_API_KEY_PUBLISH_FAILED", "AGENT_GROUP_SANDBOX_STOP_FAILED", "AGENT_GROUP_CONNECTION_NOTICE_FAILED"]);
  });

  it("changes nothing and sends nothing when the group is already disconnected", async () => {
    const { actions, dependencies } = setup();
    dependencies.repository.disconnect.mockResolvedValue({ ...GROUP, status: "already_disconnected" } as never);

    expect(await actions.disconnect(REQUEST)).toMatchObject({ status: "already_disconnected" });

    expect(dependencies.publishApiKeys).not.toHaveBeenCalled();
    expect(dependencies.stopSandboxes).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendToOwner).not.toHaveBeenCalled();
  });
});

describe("reconnect", () => {
  it("brings the group back, republishes keys and confirms to the owner", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { actions, dependencies } = setup();

    const result = await actions.reconnect(REQUEST);

    expect(dependencies.telegram.botIsMember).toHaveBeenCalledWith("-1001");
    expect(dependencies.repository.reconnect).toHaveBeenCalledWith(REQUEST);
    expect(dependencies.publishApiKeys).toHaveBeenCalledTimes(1);
    expect(dependencies.stopSandboxes).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendToOwner.mock.calls[0]![1]).toContain("снова подключена");
    expect(result).toMatchObject({ ownerNotified: true, status: "reconnected" });
  });

  it("refuses while the bot is not in the group, changing nothing", async () => {
    const { actions, dependencies } = setup();
    dependencies.telegram.botIsMember.mockResolvedValue(false);

    const refusal = await actions.reconnect(REQUEST).catch((error: unknown) => error);

    expect(isAppError(refusal) && refusal.code).toBe("AGENT_GROUP_BOT_NOT_MEMBER");
    expect(dependencies.repository.reconnect).not.toHaveBeenCalled();
  });

  it("does not ask Telegram about a group that is connected", async () => {
    const { actions, dependencies } = setup();
    dependencies.repository.find.mockResolvedValue({ ...GROUP, disconnectedAt: null, type: "external" } as never);
    dependencies.repository.reconnect.mockResolvedValue({ ...GROUP, status: "already_connected" } as never);

    expect(await actions.reconnect(REQUEST)).toMatchObject({ status: "already_connected" });

    expect(dependencies.telegram.botIsMember).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendToOwner).not.toHaveBeenCalled();
  });

  it("refuses a group the family does not have", async () => {
    const { actions, dependencies } = setup();
    dependencies.repository.find.mockResolvedValue(null as never);

    const refusal = await actions.reconnect(REQUEST).catch((error: unknown) => error);

    expect(isAppError(refusal) && refusal.code).toBe("AGENT_GROUP_NOT_FOUND");
  });
});

describe("remove", () => {
  it("deletes the raw copies around the registration, then stops sandboxes and confirms", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { actions, dependencies } = setup();
    const order: string[] = [];
    dependencies.purgeIngressCopies.mockImplementation(async () => { order.push("purge"); return 3; });
    dependencies.removeRegistration.mockImplementation(async () => {
      order.push("remove");
      return { groupId: "group-1", sandboxThreadIds: ["thread-1"], title: "Внешняя группа" };
    });
    dependencies.stopSandboxThreads.mockImplementation(async () => { order.push("sandboxes"); });

    const result = await actions.remove(REQUEST);

    expect(order).toEqual(["purge", "remove", "purge", "sandboxes"]);
    expect(dependencies.purgeIngressCopies).toHaveBeenCalledWith("-1001");
    expect(dependencies.stopSandboxThreads).toHaveBeenCalledWith(["thread-1"]);
    expect(dependencies.publishApiKeys).toHaveBeenCalledTimes(1);
    expect(dependencies.telegram.sendToOwner.mock.calls[0]![1]).toContain("удалены навсегда");
    expect(result).toMatchObject({ ownerNotified: true, status: "removed" });
  });

  it("touches nothing of a chat the family does not have", async () => {
    const { actions, dependencies } = setup();
    dependencies.repository.find.mockResolvedValue(null as never);

    const refusal = await actions.remove(REQUEST).catch((error: unknown) => error);

    expect(isAppError(refusal) && refusal.code).toBe("AGENT_GROUP_NOT_FOUND");
    expect(dependencies.purgeIngressCopies).not.toHaveBeenCalled();
    expect(dependencies.removeRegistration).not.toHaveBeenCalled();
  });

  // The group and its data stay; only the invisible raw copies may already be gone, so a retry finishes.
  it("stops when the removal itself fails, keeping the group and the reason", async () => {
    const { actions, dependencies } = setup();
    dependencies.removeRegistration.mockRejectedValue(new Error("update or delete on table violates foreign key constraint"));

    await expect(actions.remove(REQUEST)).rejects.toThrow(/foreign key/u);

    expect(dependencies.stopSandboxThreads).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendToOwner).not.toHaveBeenCalled();
  });
});

