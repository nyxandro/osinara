/**
 * Application-owned software update callback tests.
 *
 * Constructs covered:
 * - Exact private chat, message, token, query user, and action reach the atomic repository claim.
 * - Foreign and repeated callbacks bypass Eve while returning stable Russian errors.
 * - UI cleanup failures after commit never roll back an approved decision.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createSoftwareUpdateCallbackHandler } from "./callback.js";

function callbackQuery(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return {
    data: "su:a:callback-secret",
    from: { firstName: "Анна", id: "101", isBot: false },
    id: "query-1",
    message: {
      chat: { id: "101", type: "private" },
      messageId: "77",
    },
    raw: {},
    ...overrides,
  };
}

describe("software update callback handler", () => {
  it("commits an exact owner approval and then removes the keyboard", async () => {
    const repository = {
      claimDecision: vi.fn().mockResolvedValue({
        decisionId: "decision-1",
        proposalId: "proposal-1",
        status: "approved",
      }),
      recordDecisionUiFailure: vi.fn(),
    };
    const transport = {
      answerCallback: vi.fn().mockResolvedValue(undefined),
      removeKeyboard: vi.fn().mockResolvedValue(undefined),
    };
    const handle = createSoftwareUpdateCallbackHandler({ repository, transport });

    await expect(handle(callbackQuery())).resolves.toBe(true);

    expect(repository.claimDecision).toHaveBeenCalledWith({
      action: "approve",
      callbackQueryId: "query-1",
      callbackToken: "callback-secret",
      telegramChatId: "101",
      telegramChatType: "private",
      telegramMessageId: "77",
      telegramUserId: "101",
    });
    expect(transport.removeKeyboard).toHaveBeenCalledWith({ chatId: "101", messageId: "77" });
    expect(transport.answerCallback).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "query-1",
      text: expect.stringContaining("подтверждено"),
    }));
  });

  it("rejects a foreign owner callback without exposing it to Eve", async () => {
    const repository = {
      claimDecision: vi.fn().mockResolvedValue({ status: "forbidden" }),
      recordDecisionUiFailure: vi.fn(),
    };
    const transport = {
      answerCallback: vi.fn().mockResolvedValue(undefined),
      removeKeyboard: vi.fn(),
    };
    const handle = createSoftwareUpdateCallbackHandler({ repository, transport });

    await expect(handle(callbackQuery({
      from: { firstName: "Чужой", id: "202", isBot: false },
    }))).resolves.toBe(true);

    expect(transport.removeKeyboard).not.toHaveBeenCalled();
    expect(transport.answerCallback).toHaveBeenCalledWith(expect.objectContaining({
      showAlert: true,
      text: expect.stringContaining("AGENT_SOFTWARE_UPDATE_FORBIDDEN"),
    }));
  });

  it("keeps the committed decision when Telegram cleanup is ambiguous", async () => {
    const repository = {
      claimDecision: vi.fn().mockResolvedValue({
        decisionId: "decision-1",
        proposalId: "proposal-1",
        status: "declined",
      }),
      recordDecisionUiFailure: vi.fn().mockResolvedValue(undefined),
    };
    const transport = {
      answerCallback: vi.fn().mockResolvedValue(undefined),
      removeKeyboard: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const handle = createSoftwareUpdateCallbackHandler({ repository, transport });

    await expect(handle(callbackQuery({ data: "su:d:callback-secret" }))).resolves.toBe(true);

    expect(repository.claimDecision).toHaveBeenCalledTimes(1);
    expect(repository.recordDecisionUiFailure).toHaveBeenCalledWith({
      code: "AGENT_SOFTWARE_UPDATE_CALLBACK_UI_FAILED",
      message: expect.stringContaining("Telegram"),
      proposalId: "proposal-1",
    });
    expect(transport.answerCallback).toHaveBeenCalledTimes(1);
  });

  it("leaves unrelated callback prefixes for native Eve handling", async () => {
    const repository = { claimDecision: vi.fn(), recordDecisionUiFailure: vi.fn() };
    const transport = { answerCallback: vi.fn(), removeKeyboard: vi.fn() };
    const handle = createSoftwareUpdateCallbackHandler({ repository, transport });

    await expect(handle(callbackQuery({ data: "eve:0" }))).resolves.toBe(false);

    expect(repository.claimDecision).not.toHaveBeenCalled();
    expect(transport.answerCallback).not.toHaveBeenCalled();
  });
});
