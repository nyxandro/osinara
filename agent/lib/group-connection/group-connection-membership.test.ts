/**
 * Telegram's news that the bot left or rejoined a group (#465).
 *
 * Constructs covered:
 * - Removal of the bot disconnects a connected external group, stops its work and tells the owner once.
 * - The bot added back to a disconnected group only tells the owner; the group stays disconnected.
 * - A repeated or older event, a private chat and a malformed event change nothing and tell no one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotMembershipHandler, type BotMembershipDependencies } from "./group-connection-membership.js";

const GROUP = { familyId: "family-1", groupId: "group-1", telegramChatId: "-1001", title: "Внешняя группа" };

function event(status: string, overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: -1001, title: "Внешняя группа", type: "supergroup" },
    date: 1_762_300_000,
    from: { first_name: "Admin", id: 202, is_bot: false },
    new_chat_member: { status, user: { first_name: "Osinara", id: 900, is_bot: true } },
    old_chat_member: { status: "member", user: { first_name: "Osinara", id: 900, is_bot: true } },
    ...overrides,
  };
}

function setup() {
  const dependencies = {
    ownerTelegramChatId: vi.fn(async (_familyId: string) => "101"),
    publishApiKeys: vi.fn(async () => undefined),
    recordBotMembership: vi.fn(async (_input: { changedAt: Date; member: boolean; telegramChatId: string }) =>
      ({ ...GROUP, change: "disconnected" }) as Awaited<ReturnType<BotMembershipDependencies["recordBotMembership"]>>),
    sendToOwner: vi.fn(async (_chatId: string, _text: string) => undefined),
    stopSandboxes: vi.fn(async (_groupId: string) => undefined),
  };
  const handler = createBotMembershipHandler(dependencies);
  // The follow-ups run in the background after Telegram's answer; the test waits for them.
  const handle = async (update: unknown) => {
    const background: Promise<unknown>[] = [];
    await handler(update, (work) => background.push(work));
    await Promise.all(background);
  };
  return { dependencies, handle };
}

afterEach(() => vi.restoreAllMocks());

describe("bot membership", () => {
  it.each(["kicked", "left"])("disconnects the group when the bot is %s and tells the owner", async (status) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { dependencies, handle } = setup();

    await handle(event(status));

    expect(dependencies.recordBotMembership).toHaveBeenCalledWith({
      changedAt: new Date(1_762_300_000_000), member: false, telegramChatId: "-1001",
    });
    expect(dependencies.publishApiKeys).toHaveBeenCalledTimes(1);
    expect(dependencies.stopSandboxes).toHaveBeenCalledWith("group-1");
    expect(dependencies.sendToOwner).toHaveBeenCalledTimes(1);
    expect(dependencies.sendToOwner.mock.calls[0]![0]).toBe("101");
    expect(dependencies.sendToOwner.mock.calls[0]![1]).toContain("Меня удалили из группы «Внешняя группа»");
  });

  it("only tells the owner when the bot is added back to a disconnected group", async () => {
    const { dependencies, handle } = setup();
    dependencies.recordBotMembership.mockResolvedValue({ ...GROUP, change: "rejoined_while_disconnected" });

    await handle(event("member", { old_chat_member: { status: "left", user: { id: 900, is_bot: true } } }));

    expect(dependencies.recordBotMembership).toHaveBeenCalledWith(expect.objectContaining({ member: true }));
    expect(dependencies.stopSandboxes).not.toHaveBeenCalled();
    expect(dependencies.sendToOwner.mock.calls[0]![1]).toContain("Меня снова добавили в группу «Внешняя группа»");
  });

  it("tells no one when nothing changed", async () => {
    const { dependencies, handle } = setup();
    dependencies.recordBotMembership.mockResolvedValue({ change: "none" });

    await handle(event("kicked"));

    expect(dependencies.sendToOwner).not.toHaveBeenCalled();
    expect(dependencies.publishApiKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["a private chat", event("kicked", { chat: { id: 101, type: "private" } })],
    ["an event without a status", event("kicked", { new_chat_member: {} })],
    ["an event without a date", event("kicked", { date: "yesterday" })],
  ])("ignores %s", async (_case, update) => {
    const { dependencies, handle } = setup();

    await handle(update);

    expect(dependencies.recordBotMembership).not.toHaveBeenCalled();
  });

  it("keeps the disconnection when telling the owner fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { dependencies, handle } = setup();
    dependencies.sendToOwner.mockRejectedValue(new Error("HTTP 502"));

    await handle(event("kicked"));

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("AGENT_GROUP_CONNECTION_NOTICE_FAILED"));
  });
});
