/**
 * Telegram HITL callback authorization tests.
 *
 * Constructs covered:
 * - `createTelegramHitlCallbackAuthorizer`: forwards fresh verified auth only after a durable claim.
 * - Callback ownership uses the exact verified prompt message route, including private chats.
 * - Foreign and expired callbacks receive a Russian alert and never resume Eve.
 */
import type { TelegramContext, TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { buildApprovalMessage } from "./approval-message.js";
import { createTelegramHitlCallbackAuthorizer } from "./callback-authorization.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";
vi.mock("../operational-incidents/owner-alerts.js", () => ({ recordOperationalIncident: vi.fn() }));

function callbackQuery(): TelegramCallbackQuery {
  return {
    data: "eve:0",
    from: { firstName: "Анна", id: "101", isBot: false },
    id: "callback-1",
    message: {
      chat: { id: "-1001", type: "supergroup" },
      messageId: "88",
      messageThreadId: 55,
    },
    raw: {},
  };
}

function telegramContext() {
  const answerCallbackQuery = vi.fn().mockResolvedValue({ body: {}, ok: true, status: 200 });
  const request = vi.fn().mockResolvedValue({ body: {}, ok: true, status: 200 });
  return {
    answerCallbackQuery,
    context: { telegram: { answerCallbackQuery, request } } as unknown as TelegramContext,
    request,
  };
}

describe("createTelegramHitlCallbackAuthorizer", () => {
  it("forwards a committed decision even when updating its Telegram prompt fails", async () => {
    const auth = { authenticator: "telegram",principalId: "user-1",principalType: "user",attributes: { role: "owner" } };
    const repository = { claimCallback: vi.fn().mockResolvedValue({ status: "authorized",auth,continuationToken: "exact",
      promptText: "Подтвердите",selectedOptionId: "approve",selectedOptionLabel: "Да" }) };
    const { context,request } = telegramContext();
    request.mockRejectedValueOnce(new Error("Telegram unavailable"));
    await expect(createTelegramHitlCallbackAuthorizer(repository)(context,callbackQuery(),"exact"))
      .resolves.toMatchObject({ auth,continuationToken: "exact" });
    expect(recordOperationalIncident).toHaveBeenCalledWith(expect.objectContaining({ code: "AGENT_APPROVAL_MESSAGE_FINALIZE_FAILED" }));
  });
  it("returns the freshly claimed Telegram auth to Eve", async () => {
    const auth = {
      attributes: { applicationSessionId: "session-1", role: "member" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const repository = {
      claimCallback: vi.fn().mockResolvedValue({
        auth,
        continuationToken: "-1001:55:88:osinara:2",
        promptText: "Возобновить расписание «Утренний дайджест ИИ»?",
        selectedOptionId: "approve",
        selectedOptionLabel: "Да, подтвердить",
        status: "authorized",
      }),
    };
    const authorize = createTelegramHitlCallbackAuthorizer(repository);
    const { context, answerCallbackQuery, request } = telegramContext();

    await expect(authorize(context, callbackQuery(), "-1001:55:88"))
      .resolves.toEqual({
        acknowledgementText: "Решение сохранено",
        auth,
        continuationToken: "-1001:55:88:osinara:2",
      });
    expect(repository.claimCallback).toHaveBeenCalledWith({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: "101",
    });
    expect(answerCallbackQuery).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("editMessageText", {
      chat_id: "-1001",
      message_id: 88,
      reply_markup: { inline_keyboard: [] },
      text: expect.stringContaining("Подтверждено"),
    });
  });

  it.each([
    ["forbidden", "AGENT_APPROVAL_FORBIDDEN"],
    ["expired", "AGENT_APPROVAL_EXPIRED"],
  ] as const)("blocks a %s callback before Eve resume", async (status, code) => {
    const authorize = createTelegramHitlCallbackAuthorizer({
      claimCallback: vi.fn().mockResolvedValue({ status }),
    });
    const { context, answerCallbackQuery } = telegramContext();

    await expect(authorize(context, callbackQuery(), "-1001:55:88")).resolves.toBeNull();
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "callback-1",
      showAlert: true,
      text: expect.stringContaining(code),
    }));
  });

  it("claims a private callback through the exact prompt alias", async () => {
    const claimCallback = vi.fn().mockResolvedValue({ status: "expired" });
    const authorize = createTelegramHitlCallbackAuthorizer({ claimCallback });
    const { context } = telegramContext();
    const query = {
      ...callbackQuery(),
      message: {
        chat: { id: "101", type: "private" as const },
        messageId: "88",
      },
    };

    await authorize(context, query, "101::");

    expect(claimCallback).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "101::88",
      telegramChatId: "101",
      telegramMessageId: "88",
    }));
  });

  it("replaces a denied prompt with an explicit rejection and no buttons", async () => {
    const auth = {
      attributes: { applicationSessionId: "session-1", role: "member" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const authorize = createTelegramHitlCallbackAuthorizer({
      claimCallback: vi.fn().mockResolvedValue({
        auth,
        continuationToken: "-1001:55:88:osinara:2",
        promptText: "Удалить расписание «Утренний дайджест ИИ»?",
        selectedOptionId: "cancel",
        selectedOptionLabel: "Нет, отклонить",
        status: "authorized",
      }),
    });
    const { context, request } = telegramContext();

    await authorize(context, callbackQuery(), "-1001:55:88");

    expect(request).toHaveBeenCalledWith("editMessageText", expect.objectContaining({
      reply_markup: { inline_keyboard: [] },
      text: expect.stringContaining("Отменено"),
    }));
  });

  it("does not keep promising an execution next to the cancellation", async () => {
    // Сквозная проверка исправляемого бага: реальное собранное окно, а не строка без последствия.
    const composed = buildApprovalMessage({
      actionLabel: "удалить агентное расписание",
      facts: ["Расписание: Утренний дайджест ИИ"],
    });
    expect(composed).toContain("будет выполнено один раз");

    const authorize = createTelegramHitlCallbackAuthorizer({
      claimCallback: vi.fn().mockResolvedValue({
        auth: {
          attributes: { applicationSessionId: "session-1", role: "member" },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user" as const,
        },
        continuationToken: "-1001:55:88:osinara:2",
        promptText: composed,
        selectedOptionId: "cancel",
        selectedOptionLabel: "Нет, отменить",
        status: "authorized",
      }),
    });
    const { context, request } = telegramContext();

    await authorize(context, callbackQuery(), "-1001:55:88");

    const [, body] = request.mock.calls.find(([method]) => method === "editMessageText")!;
    expect((body as { text: string }).text).not.toContain("будет выполнено один раз");
    expect((body as { text: string }).text).toContain("Действие не будет выполнено.");
    expect((body as { text: string }).text).toContain("Расписание: Утренний дайджест ИИ");
  });
});
