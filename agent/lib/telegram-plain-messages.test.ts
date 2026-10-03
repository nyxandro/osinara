/**
 * Native plain Telegram message delivery tests.
 *
 * Constructs covered:
 * - Plain output uses `sendMessage` without parse mode or Rich Message payloads.
 * - Missing Telegram delivery identity is terminally ambiguous.
 */
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";
import { describe, expect, it, vi } from "vitest";

import { postTelegramPlainMessageChunk } from "./telegram-plain-messages.js";

describe("plain Telegram messages", () => {
  it("sends ordinary text without formatting fields", async () => {
    const request = vi.fn().mockResolvedValue({
      body: { ok: true, result: { chat: { type: "private" }, message_id: 71 } },
      ok: true,
      status: 200,
    });
    const channel = {
      state: { chatId: "101", chatType: "private", messageThreadId: null },
      telegram: { request },
    } as unknown as TelegramEventContext;

    await expect(postTelegramPlainMessageChunk(
      "да, работает",
      channel,
      { allow_sending_without_reply: true, message_id: 55 },
    )).resolves.toEqual({ chatType: "private", messageId: "71" });
    expect(request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "101",
      reply_parameters: { allow_sending_without_reply: true, message_id: 55 },
      text: "да, работает",
    });
    expect(request.mock.calls[0]![1]).not.toHaveProperty("parse_mode");
    expect(request.mock.calls[0]![1]).not.toHaveProperty("rich_message");
  });

  it("uses the confirmed Telegram chat type when proactive state has no inbound chat type", async () => {
    const request = vi.fn().mockResolvedValue({
      body: { ok: true, result: { chat: { type: "private" }, message_id: 72 } },
      ok: true,
      status: 200,
    });
    const channel = {
      state: { chatId: "101", chatType: null, messageThreadId: null },
      telegram: { request },
    } as unknown as TelegramEventContext;

    await expect(postTelegramPlainMessageChunk("ответ расписания", channel))
      .resolves.toEqual({ chatType: "private", messageId: "72" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a response without verified message identity", async () => {
    const channel = {
      state: { chatId: "101", chatType: "private", messageThreadId: null },
      telegram: {
        request: vi.fn().mockResolvedValue({
          body: { ok: true, result: {} }, ok: true, status: 200,
        }),
      },
    } as unknown as TelegramEventContext;

    await expect(postTelegramPlainMessageChunk(
      "ответ",
      channel,
    )).rejects.toThrowError(/AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS/u);
  });

  it("rejects a chunk that the runtime would split behind the durable outbox", async () => {
    const request = vi.fn();
    const channel = {
      state: { chatId: "101", chatType: "private", messageThreadId: null },
      telegram: { request },
    } as unknown as TelegramEventContext;

    await expect(postTelegramPlainMessageChunk(
      "🙂".repeat(2_049),
      channel,
    )).rejects.toThrowError(/AGENT_TELEGRAM_PLAIN_MESSAGE_INPUT_INVALID/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("marks an explicit provider rejection as definitive", async () => {
    const channel = {
      state: { chatId: "101", chatType: "private", messageThreadId: null },
      telegram: {
        request: vi.fn().mockResolvedValue({
          body: { description: "Bad Request", ok: false }, ok: false, status: 400,
        }),
      },
    } as unknown as TelegramEventContext;

    await expect(postTelegramPlainMessageChunk("ответ", channel))
      .rejects.toThrowError(/AGENT_TELEGRAM_MESSAGE_DELIVERY_FAILED/u);
  });
});
