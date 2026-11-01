/**
 * Capture of an API key from the owner's private message before it reaches the queue.
 *
 * Constructs covered:
 * - While a wait is open, a message that is the key is encrypted and stored for that very wait, the
 *   message is deleted and the owner is told; the model never receives it.
 * - A key among other words is withheld and deleted, and the wait stays open.
 * - An ordinary message ends the wait and goes to the agent as usual.
 * - Within the guard after a wait, a key sent late or a second time is withheld, never forwarded,
 *   while ordinary messages pass.
 * - A key-shaped message whose wait closed meanwhile is withheld.
 * - Telegram delivering the same update again is consumed silently, deleting the message once more.
 * - Group messages, files, captions and other people's messages are not inspected at all.
 */
import { describe, expect, it, vi } from "vitest";

import type { TelegramMessage, TelegramUpdate } from "../../runtime/telegram/inbound.js";
import { createApiKeyIntake, type ApiKeyIntakeDependencies } from "./api-key-intake.js";

const KEY = "sk-live-1234567890abcdefghij";
const ENCRYPTED = { authTag: "dGFn", ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" };
const EXPIRES_AT = new Date("2026-11-01T12:30:00Z");
const OPEN = { expiresAt: EXPIRES_AT, keyId: "key-1", kind: "open", name: "neuraldeep" } as const;
const GUARDED = { keyId: "key-1", kind: "guarded", name: "neuraldeep" } as const;

function message(text: string, overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    kind: "message",
    message: {
      attachments: [],
      caption: "",
      chat: { id: "101", type: "private" },
      from: { id: "101" } as TelegramMessage["from"],
      messageId: "55",
      raw: {},
      text,
      ...overrides,
    },
  };
}

function setup(found: Awaited<ReturnType<ApiKeyIntakeDependencies["find"]>> = OPEN) {
  const dependencies = {
    cancel: vi.fn().mockResolvedValue(undefined),
    encrypt: vi.fn().mockReturnValue(ENCRYPTED),
    find: vi.fn().mockResolvedValue(found),
    publish: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(true),
    telegram: {
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
  const background: Promise<unknown>[] = [];
  const capture = createApiKeyIntake(dependencies as ApiKeyIntakeDependencies);
  return {
    dependencies,
    run: async (update: TelegramUpdate, updateId = "900") => {
      const consumed = await capture(update, updateId, (work) => background.push(work));
      await Promise.all(background);
      return consumed;
    },
  };
}

describe("API key intake", () => {
  it("stores the key for the wait it was matched to, deletes the message and tells the owner", async () => {
    const { dependencies, run } = setup();

    expect(await run(message(`  ${KEY}\n`))).toBe(true);

    expect(dependencies.find).toHaveBeenCalledWith({ telegramChatId: "101", updateId: "900" });
    expect(dependencies.encrypt).toHaveBeenCalledWith(KEY);
    expect(dependencies.store).toHaveBeenCalledWith({
      expiresAt: EXPIRES_AT, keyId: "key-1", telegramChatId: "101", updateId: "900", value: ENCRYPTED,
    });
    expect(dependencies.publish).toHaveBeenCalledTimes(1);
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    const notice = dependencies.telegram.sendMessage.mock.calls[0]![1] as string;
    expect(notice).toContain("«neuraldeep» сохранён");
    expect(notice).not.toContain(KEY);
  });

  it("asks the owner to delete the message when the bot could not", async () => {
    const { dependencies, run } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dependencies.telegram.deleteMessage.mockRejectedValue(new Error("message can't be deleted"));

    expect(await run(message(KEY))).toBe(true);

    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("удалите его вручную");
    vi.restoreAllMocks();
  });

  it("withholds a key whose wait closed meanwhile", async () => {
    const { dependencies, run } = setup();
    dependencies.store.mockResolvedValue(false);

    expect(await run(message(KEY))).toBe(true);

    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("уже закончилось");
  });

  it("withholds a key among other words and keeps waiting", async () => {
    const { dependencies, run } = setup();

    expect(await run(message(`вот ключ: ${KEY}`))).toBe(true);

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("только сам ключ");
  });

  it.each(["а где взять ключ?", "https://docs.neuraldeep.ru/api/keys"])(
    "ends the wait on the ordinary message %j and lets it reach the agent",
    async (text) => {
      const { dependencies, run } = setup();

      expect(await run(message(text))).toBe(false);

      expect(dependencies.cancel).toHaveBeenCalledWith({ keyId: "key-1", telegramChatId: "101" });
      expect(dependencies.store).not.toHaveBeenCalled();
      expect(dependencies.telegram.deleteMessage).not.toHaveBeenCalled();
      expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("отменено");
    },
  );

  it.each([KEY, `вот ключ: ${KEY}`])("withholds %j sent within the guard after the wait", async (text) => {
    const { dependencies, run } = setup(GUARDED);

    expect(await run(message(text))).toBe(true);

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("уже закончилось");
  });

  it("lets an ordinary message through within the guard, silently", async () => {
    const { dependencies, run } = setup(GUARDED);

    expect(await run(message("спасибо, работает"))).toBe(false);

    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("consumes a repeated delivery of the update that brought the key and deletes it once more", async () => {
    const { dependencies, run } = setup({ kind: "delivered" });

    expect(await run(message(KEY))).toBe(true);

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("lets a message through when no wait or guard exists", async () => {
    const { dependencies, run } = setup(null);

    expect(await run(message(KEY))).toBe(false);

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["a group message", message(KEY, { chat: { id: "-100500", type: "supergroup" } })],
    ["a file", message("", { attachments: [{ fileId: "f", kind: "document" }] })],
    ["a caption", message("", { caption: KEY })],
    ["a message from someone else", message(KEY, { from: { id: "202" } as TelegramMessage["from"] })],
    ["a button press", { callbackQuery: { from: { id: "101" }, id: "q", raw: {} }, kind: "callback_query" } as TelegramUpdate],
  ])("does not inspect %s", async (_case, update) => {
    const { dependencies, run } = setup();

    expect(await run(update)).toBe(false);

    expect(dependencies.find).not.toHaveBeenCalled();
  });
});
