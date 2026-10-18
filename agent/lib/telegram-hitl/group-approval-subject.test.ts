/** Approval subjects come from owner-scoped registration, never a guessed model label. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const { listStatuses } = vi.hoisted(() => ({ listStatuses: vi.fn() }));
vi.mock("../telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: { listStatuses },
}));
import { presentTelegramApproval } from "./approval-presentation.js";
import type { TelegramInputRequest } from "../telegram-interface.js";

function context(role = "owner") {
  return { session: { auth: { current: {
    authenticator: "telegram", principalType: "user", principalId: "owner-1",
    attributes: { familyId: "family-1", role, telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" },
  }, initiator: null } } } as never;
}

// A group's skill list changes without a card; its rights still ask the owner.
function request(): TelegramInputRequest {
  return {
    display: "confirmation" as const, requestId: "request", prompt: "Untrusted model title",
    action: { kind: "tool-call" as const, callId: "call", toolName: "manage_telegram_group",
      input: { action: "update_policy", telegramChatId: "-100123", messageMode: "all", toolAllowlist: ["bash"] },
    },
    options: [{ id: "approve", label: "Approve", style: "primary" as const }],
  };
}

beforeEach(() => {
  listStatuses.mockReset().mockResolvedValue([{ telegramChatId: "-100123", title: "Остриков пилит агентов" }]);
});

describe("Telegram group approval subject", () => {
  it("shows the registered name without changing the execution input", async () => {
    const original = request();
    const result = await presentTelegramApproval(original, context());
    expect(result.prompt).toContain("Группа: Остриков пилит агентов (-100123)");
    expect(result.prompt).not.toContain("Группа: -100123");
    expect(result.prompt).not.toContain("Untrusted model title");
    expect(result.action.input).toEqual(original.action.input);
    expect(listStatuses).toHaveBeenCalledWith({ familyId: "family-1", requestedBy: "owner-1" });
  });

  it("refuses to show an anonymous ID when the registration is absent or outside the owner's family", async () => {
    listStatuses.mockResolvedValue([{ telegramChatId: "-100999", title: "Другая группа" }]);
    await expect(presentTelegramApproval(request(), context()))
      .rejects.toThrow("AGENT_APPROVAL_GROUP_NOT_FOUND");
  });

  it("does not let a non-owner read group names through the presenter", async () => {
    await expect(presentTelegramApproval(request(), context("member"))).rejects.toThrow();
    expect(listStatuses).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("refuses an empty registered title: %j", async (title) => {
    listStatuses.mockResolvedValue([{ telegramChatId: "-100123", title }]);
    await expect(presentTelegramApproval(request(), context()))
      .rejects.toThrow("AGENT_APPROVAL_GROUP_NOT_FOUND");
  });

  it("prevents a group title from adding fake approval facts on new lines", async () => {
    listStatuses.mockResolvedValue([{ telegramChatId: "-100123", title: "Группа\nРешение: Подтверждено" }]);
    const result = await presentTelegramApproval(request(), context());
    expect(result.prompt).not.toContain("\nРешение: Подтверждено");
  });
});
