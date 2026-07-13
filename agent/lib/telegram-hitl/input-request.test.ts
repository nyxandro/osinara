/**
 * Telegram HITL input rendering tests.
 *
 * Constructs covered:
 * - `createTelegramInputRequestHandler`: persists approver identity before exposing buttons.
 * - Every rendered request receives its own durable Telegram continuation route.
 */
import type { SessionContext } from "eve/context";
import type { TelegramEventContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramInputRequestHandler } from "./input-request.js";

describe("createTelegramInputRequestHandler", () => {
  it("registers the expected approver and route before exposing callback buttons", async () => {
    const markPendingOperation = vi.fn();
    const register = vi.fn();
    const rekey = vi.fn();
    const post = vi.fn().mockResolvedValue({ id: "88", raw: null });
    const request = vi.fn().mockResolvedValue({ body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      markPendingOperation,
      rekey,
    });
    const channel = {
      continuationToken: "-1001:55:77",
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { post, request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: {
          callId: "call-1",
          input: { action: "create" },
          kind: "tool-call",
          toolName: "manage_reminder",
        },
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(markPendingOperation).toHaveBeenCalledWith("app-session-1", true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      text: "Подготавливаю безопасный запрос подтверждения.",
    }));
    expect(post.mock.calls[0]?.[0]).not.toHaveProperty("reply_markup");
    expect(rekey).toHaveBeenCalledWith(channel, ctx);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      callbackData: ["eve:0", "eve:1"],
      eveSessionId: "wrun_hitl",
      requestId: "request-1",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "88",
      telegramMessageThreadId: "55",
      telegramUserId: "101",
    }));
    expect(request).toHaveBeenCalledWith("editMessageText", {
      chat_id: "-1001",
      message_id: 88,
      message_thread_id: 55,
      reply_markup: expect.any(Object),
      text: expect.any(String),
    });
    expect(rekey.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[0]!);
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]!,
    );
  });

  it("opens ForceReply only on the non-actionable placeholder for a freeform request", async () => {
    const register = vi.fn();
    const post = vi.fn().mockResolvedValue({ id: "90", raw: null });
    const request = vi.fn().mockResolvedValue({ body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      markPendingOperation: vi.fn(),
      rekey: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { post, request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: { applicationSessionId: "app-session-1", telegramUserId: "101" },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-freeform",
      }],
    } as never, channel, ctx);

    expect(post).toHaveBeenCalledWith({
      reply_markup: expect.objectContaining({ force_reply: true }),
      text: "Подготавливаю безопасный запрос подтверждения.",
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ callbackData: [] }));
    expect(request).toHaveBeenCalledWith(
      "editMessageText",
      expect.objectContaining({ text: "Уточните значение" }),
    );
  });
});
