/**
 * Telegram HITL input rendering tests.
 *
 * Constructs covered:
 * - Any group chat rejects every confirmation prompt before any Telegram or durable side effect.
 * - `createTelegramInputRequestHandler`: persists approver identity before exposing buttons.
 * - Interactive and scheduled requests receive aliases without changing Eve's continuation hook.
 * - Long approval prompts are delivered completely before the actionable final message.
 */
import type { SessionContext } from "eve/context";
import type { TelegramEventContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramInputRequestHandler } from "./input-request.js";

describe("createTelegramInputRequestHandler", () => {
  it.each([
    {
      chatNotice: true,
      code: "AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN",
      groupType: "external",
      kind: "session-limit",
      signal: "session budget by request kind",
      toolName: "manage_agent_schedule",
    },
    {
      chatNotice: true,
      code: "AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN",
      groupType: "external",
      kind: "tool-approval",
      signal: "session budget by synthetic tool name",
      toolName: "session_limit_continuation",
    },
    {
      code: "AGENT_EXTERNAL_APPROVAL_FORBIDDEN",
      groupType: "external",
      kind: "question",
      signal: "a framework question, which a public chat cannot carry either",
      toolName: "ask_question",
    },
    {
      code: "AGENT_EXTERNAL_APPROVAL_FORBIDDEN",
      groupType: "external",
      kind: "tool-approval",
      signal: "an ordinary application tool approval",
      toolName: "manage_reminder",
    },
    {
      chatNotice: true,
      code: "AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN",
      groupType: "family_private",
      kind: "session-limit",
      signal: "session budget in the family group",
      toolName: "manage_agent_schedule",
    },
    {
      code: "AGENT_EXTERNAL_APPROVAL_FORBIDDEN",
      groupType: "family_private",
      kind: "tool-approval",
      signal: "a Google Workspace mutation in the family group",
      toolName: "execute_google_workspace",
    },
  ])("rejects a $groupType group prompt: $signal, before side effects", async ({
    chatNotice,
    code,
    groupType,
    kind,
    toolName,
  }) => {
    const parkSession = vi.fn();
    const present = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockResolvedValue({
      body: { ok: true, result: { message_id: 94 } },
      ok: true,
      status: 200,
    });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType,
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_root",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await expect(handler({
      requests: [{
        action: {
          callId: "wrun_child:limit:input:36140505",
          input: { kind: "input", limit: 36_140_505, usedTokens: 36_140_505 },
          kind: "tool-call",
          toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind,
        options: [
          { id: "continue", label: "Approve", style: "primary" },
          { id: "stop", label: "Stop", style: "danger" },
        ],
        prompt: "Approve a fresh token budget",
        requestId: "wrun_child:limit:input:36140505",
      }],
    } as never, channel, ctx)).rejects.toThrow(code);
    expect(present).not.toHaveBeenCalled();
    expect(parkSession).not.toHaveBeenCalled();
    expect(registerMessageRoutes).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    // Only the budget refusal speaks to the chat, and it binds nothing while doing so.
    expect(request.mock.calls.map(([method]) => method))
      .toEqual(chatNotice === true ? ["sendMessage"] : []);
  });

  it.each([
    {
      chatType: "supergroup",
      groupAttribute: {},
      signal: "a shared chat that names no registered group",
    },
    {
      chatType: "private",
      groupAttribute: { groupType: "family_private" },
      signal: "a private chat whose verified turn still belongs to a group",
    },
  ])("refuses on either signal alone: $signal", async ({ chatType, groupAttribute }) => {
    const parkSession = vi.fn();
    const present = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType,
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              ...groupAttribute,
              telegramChatId: "-1001",
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

    await expect(handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_APPROVAL_FORBIDDEN");
    expect(present).not.toHaveBeenCalled();
    expect(parkSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      attributes: { telegramChatType: "private" },
      expected: "private",
      signal: "a scheduled personal run, whose chat type is known only from the stored schedule",
    },
  ])("presents a prompt for $signal", async ({ attributes, expected }) => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 92 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (input) => input,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        // A scheduled run opens before any Telegram response, so the channel has anchored no type.
        chatType: null,
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              scheduledRunId: "run-1",
              telegramChatId: "101",
              telegramUserId: "101",
              ...attributes,
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
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [{ id: "approve", label: "Yes", style: "primary" }],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(parkSession).toHaveBeenCalled();
    // The settled approval is claimed by the stored chat type, so it must be the verified one.
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ telegramChatType: expected }));
  });

  it("refuses a scheduled group run instead of failing on an unknown chat type", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: null,
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupId: "group-1",
              groupType: "family_private",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
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

    await expect(handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_APPROVAL_FORBIDDEN");
    expect(parkSession).not.toHaveBeenCalled();
  });

  it("refuses a verified chat type that belongs to another chat than the channel", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: null,
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "-1001",
              telegramChatType: "private",
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

    await expect(handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_APPROVAL_CONTEXT_INVALID");
    expect(parkSession).not.toHaveBeenCalled();
  });

  it("fails closed when neither the channel nor the verified turn knows the chat type", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: null,
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
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

    await expect(handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_APPROVAL_CONTEXT_INVALID");
    expect(parkSession).not.toHaveBeenCalled();
  });

  it("explains a refused session budget in the shared chat before the turn ends", async () => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const request = vi.fn().mockResolvedValue({
      body: { ok: true, result: { message_id: 93 } },
      ok: true,
      status: 200,
    });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupId: "group-1",
              groupType: "family_private",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
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

    await expect(handler({
      requests: [{
        action: {
          callId: "wrun_child:limit",
          input: { kind: "input" },
          kind: "tool-call",
          toolName: "manage_agent_schedule",
        },
        display: "confirmation",
        kind: "session-limit",
        options: [],
        prompt: "Approve a fresh token budget",
        requestId: "wrun_child:limit",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN");

    expect(request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: "-1001",
      text: expect.stringContaining("Разбейте запрос на части"),
    }));
    // Explaining the stop is not the same as opening a prompt: nothing durable is bound.
    expect(parkSession).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("stays silent in the shared chat for a refused tool approval, which the model explains itself", async () => {
    const request = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession: vi.fn(),
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType: "family_private",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
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

    await expect(handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_APPROVAL_FORBIDDEN");
    expect(request).not.toHaveBeenCalled();
  });

  it("asks the family group a plain question, which authorizes nothing", async () => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 95 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (input) => input,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupId: "group-1",
              groupType: "family_private",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
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
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        display: "text",
        kind: "question",
        options: [{ id: "yes", label: "Да", style: "primary" }],
        prompt: "Какой вариант выбрать?",
        requestId: "request-question",
      }],
    } as never, channel, ctx);

    expect(parkSession).toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ telegramChatType: "supergroup" }));
  });

  it("still refuses an authorization in the family group even next to a question", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn(),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType: "family_private",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
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

    // One batch may carry both: an approval inside it must not ride in on the question.
    await expect(handler({
      requests: [
        {
          action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
          display: "text",
          kind: "question",
          options: [],
          prompt: "Какой вариант выбрать?",
          requestId: "request-question",
        },
        {
          action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "manage_gmail_message" },
          display: "confirmation",
          kind: "tool-approval",
          options: [],
          prompt: "Approve tool call",
          requestId: "request-approval",
        },
      ],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_APPROVAL_FORBIDDEN");
    expect(parkSession).not.toHaveBeenCalled();
  });

  it("does not park a session when semantic presentation fails", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn().mockRejectedValue(new Error("presentation failed")),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "101",
              telegramChatType: "private",
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

    await expect(handler({
      requests: [{
        action: {
          callId: "call-1",
          input: { action: "create" },
          kind: "tool-call",
          toolName: "manage_agent_schedule",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("presentation failed");
    expect(parkSession).not.toHaveBeenCalled();
    expect(channel.telegram.request).not.toHaveBeenCalled();
  });

  it("registers the expected approver and route before exposing callback buttons", async () => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 88 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (request) => request,
      registerMessageRoutes,
    });
    const channel = {
      continuationToken: "101",
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "101",
              telegramChatType: "private",
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
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(parkSession).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      pendingRequestId: "request-1",
      requesterTelegramUserId: "101",
      requesterUserId: null,
    });
    expect(request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: "101",
      text: "Подготавливаю безопасный запрос подтверждения.",
    }));
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("reply_markup");
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("message_thread_id");
    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["88"]);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      callbackData: ["eve:0", "eve:1"],
      callbackOptions: [
        { callbackData: "eve:0", label: "Yes", optionId: "approve" },
        { callbackData: "eve:1", label: "No", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "request-1",
      promptText: "Approve tool call",
      telegramChatId: "101",
      telegramChatType: "private",
      telegramMessageId: "88",
      telegramMessageThreadId: null,
      telegramUserId: "101",
      toolCallId: "call-1",
      toolInputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      toolName: "manage_reminder",
    }));
    expect(request).toHaveBeenCalledWith("editMessageText", {
      chat_id: "101",
      message_id: 88,
      reply_markup: expect.any(Object),
      text: expect.any(String),
    });
    expect(registerMessageRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      register.mock.invocationCallOrder[0]!,
    );
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[1]!,
    );
  });

  it("opens ForceReply only on the non-actionable placeholder for a freeform request", async () => {
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 90 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (request) => request,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatType: "private",
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
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        kind: "question",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-freeform",
      }],
    } as never, channel, ctx);

    expect(request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "101",
      reply_markup: expect.objectContaining({ force_reply: true }),
      text: "Подготавливаю безопасный запрос подтверждения.",
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ callbackData: [] }));
    expect(request).toHaveBeenCalledWith(
      "editMessageText",
      expect.objectContaining({ text: "Уточните значение" }),
    );
  });

  it("registers the exact callback route for a scheduled request", async () => {
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 91 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession: vi.fn(),
      present: async (input) => input,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              scheduledRunId: "run-1",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_scheduled_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        kind: "question",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-scheduled",
      }],
    } as never, channel, ctx);

    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["91"]);
  });

  it("shows every part of a long confirmation before exposing approval buttons", async () => {
    const longPrompt = `${"Начало и подробности операции. ".repeat(250)}КОНЕЦ_ПОЛНОГО_ТЕКСТА`;
    let nextMessageId = 100;
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: nextMessageId++ } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (input) => ({ ...input, prompt: longPrompt }),
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "101",
              telegramChatType: "private",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_long_hitl",
        turn: { id: "turn-long", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: {
          callId: "call-long",
          input: { action: "update" },
          kind: "tool-call",
          toolName: "manage_agent_schedule",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-long",
      }],
    } as never, channel, ctx);

    const sends = request.mock.calls.filter(([method]) => method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.slice(0, -1).map((call) => String(call[1].text)).join("\n"))
      .toContain("Начало и подробности операции");
    const edit = request.mock.calls.find(([method]) => method === "editMessageText");
    expect(edit?.[1]).toMatchObject({ reply_markup: expect.any(Object) });
    expect(String(edit?.[1].text)).toContain("КОНЕЦ_ПОЛНОГО_ТЕКСТА");
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ promptText: longPrompt }));
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder.at(-1)!,
    );
  });
});
