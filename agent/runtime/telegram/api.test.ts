/** Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callTelegramApi,
  registerTelegramGroupSendGate,
  sendTelegramChatAction,
  sendTelegramMessage,
  splitTelegramMessageText,
  telegramContinuationToken,
} from "./api.js";

describe("telegramContinuationToken", () => {
  it("builds a channel-local token from chat, topic, and conversation ids", () => {
    expect(telegramContinuationToken({ chatId: 123 })).toBe("123::");
    expect(
      telegramContinuationToken({
        chatId: "-1001",
        conversationId: 88,
        messageThreadId: 7,
      }),
    ).toBe("-1001:7:88");
  });
});

describe("callTelegramApi", () => {
  it("posts JSON to the bot API with the resolved token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await callTelegramApi({
      apiBaseUrl: "https://telegram.example",
      body: { chat_id: "C1", text: "hello" },
      botToken: "bot-token",
      fetch: fetchMock,
      method: "sendMessage",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.example/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({ chat_id: "C1", text: "hello" }),
        method: "POST",
      }),
    );
  });

  it("keeps the Telegram token delimiter unescaped in the API path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await callTelegramApi({
      apiBaseUrl: "https://telegram.example",
      botToken: "123456:ABCDEF",
      fetch: fetchMock,
      method: "getMe",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe("https://telegram.example/bot123456:ABCDEF/getMe");
  });
});

// The application's last line against writing to a disconnected group, whatever path forgot (#465).
describe("group send gate", () => {
  afterEach(() => {
    registerTelegramGroupSendGate(null);
    vi.restoreAllMocks();
  });

  function okFetch() {
    return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
  }

  it("does not send to a group the gate closes, and reports it loudly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = vi.fn(async (chatId: string) => chatId !== "-1001");
    registerTelegramGroupSendGate(gate);
    const fetchMock = okFetch();

    await expect(callTelegramApi({ body: { chat_id: -1001, text: "hi" }, botToken: "t", fetch: fetchMock, method: "sendMessage" }))
      .rejects.toThrow(/^AGENT_GROUP_DISCONNECTED_SEND_BLOCKED:/u);
    const form = new FormData();
    form.set("chat_id", "-1001");
    await expect(callTelegramApi({ botToken: "t", fetch: fetchMock, form, method: "sendDocument" }))
      .rejects.toThrow(/^AGENT_GROUP_DISCONNECTED_SEND_BLOCKED:/u);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate).toHaveBeenCalledWith("-1001");
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({
      chatId: "-1001", code: "AGENT_GROUP_DISCONNECTED_SEND_BLOCKED", method: "sendMessage",
    });
  });

  it("lets through a working group, a private chat and every read", async () => {
    const gate = vi.fn(async (chatId: string) => chatId !== "-1001");
    registerTelegramGroupSendGate(gate);
    const fetchMock = okFetch();

    await callTelegramApi({ body: { chat_id: "-1002", text: "hi" }, botToken: "t", fetch: fetchMock, method: "sendMessage" });
    await callTelegramApi({ body: { chat_id: 101, text: "hi" }, botToken: "t", fetch: fetchMock, method: "sendMessage" });
    await callTelegramApi({ body: { chat_id: -1001, user_id: 5 }, botToken: "t", fetch: fetchMock, method: "getChatMember" });
    await callTelegramApi({ body: { callback_query_id: "q" }, botToken: "t", fetch: fetchMock, method: "answerCallbackQuery" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

describe("sendTelegramMessage", () => {
  it("extracts the posted message id and chat id from Telegram's response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: -1001 } },
        }),
      ),
    );

    const posted = await sendTelegramMessage({
      body: { text: "hello" },
      chatId: -1001,
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
    });

    expect(posted).toMatchObject({ chatId: "-1001", id: "42" });
  });

  it("extracts recognized chat types from Telegram's response", async () => {
    for (const chatType of ["channel", "group", "private", "supergroup"] as const) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 42, chat: { id: -1001, type: chatType } },
          }),
        ),
      );

      const posted = await sendTelegramMessage({
        body: { text: "hello" },
        chatId: -1001,
        credentials: { botToken: "bot-token" },
        fetch: fetchMock,
      });

      expect(posted).toMatchObject({ chatType });
    }
  });

  it("ignores missing and unrecognized chat types from Telegram's response", async () => {
    for (const chat of [{ id: -1001 }, { id: -1001, type: "bot" }]) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 42, chat },
          }),
        ),
      );

      const posted = await sendTelegramMessage({
        body: { text: "hello" },
        chatId: -1001,
        credentials: { botToken: "bot-token" },
        fetch: fetchMock,
      });

      expect(posted.chatType).toBeUndefined();
    }
  });
});

describe("sendTelegramChatAction", () => {
  it("passes message_thread_id when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await sendTelegramChatAction({
      action: "typing",
      chatId: "-1001",
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
      messageThreadId: 10,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      action: "typing",
      chat_id: "-1001",
      message_thread_id: 10,
    });
  });
});

describe("splitTelegramMessageText", () => {
  it("keeps short content intact and splits long content at Telegram's cap", () => {
    expect(splitTelegramMessageText("short")).toEqual(["short"]);

    const chunks = splitTelegramMessageText(`${"a".repeat(4090)}\n${"b".repeat(20)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
    expect(chunks[1]).toBe("bbbbbbbbbbbbbbbbbbbb");
  });
});
