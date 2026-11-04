/**
 * Capture of an API key from the owner's private message before it reaches the queue.
 *
 * Constructs covered:
 * - While a wait is open, a message that is the key is encrypted and stored for that very wait, the
 *   key is applied, the message is deleted and the owner is told.
 * - The stored key's update goes on to the agent with the application's notice in place of the key:
 *   only the message's routing fields are kept, so the key never reaches the queue or the model.
 * - The key is applied before the update goes on, so the agent's turn can already use it; a failed
 *   application is said in the notice.
 * - A key among other words is withheld and deleted, and the wait stays open.
 * - An ordinary message ends the wait and goes to the agent as usual.
 * - Within the guard after a wait, a key sent late or a second time is withheld, never forwarded,
 *   while ordinary messages pass.
 * - A key-shaped message whose wait closed meanwhile is withheld.
 * - Telegram delivering the same update again applies the key again and deletes the message once
 *   more, without a second notice to the owner; the agent's notice goes on only if the queue does
 *   not hold the update yet.
 * - Group messages, files, captions and other people's messages are not inspected at all.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate, type TelegramMessage, type TelegramUpdate } from "../../runtime/telegram/inbound.js";
import { prepareMemoryQuery } from "../memory-query-preparation.js";
import { isApiKeyDeliveredModelText } from "../telegram-model-placeholders.js";
import { createApiKeyIntake, type ApiKeyCapture, type ApiKeyIntakeDependencies } from "./api-key-intake.js";

const KEY = "sk-live-1234567890abcdefghij";
const ENCRYPTED = { authTag: "dGFn", ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" };
const EXPIRES_AT = new Date("2026-11-01T12:30:00Z");
const OPEN = { expiresAt: EXPIRES_AT, keyId: "key-1", kind: "open", name: "neuraldeep" } as const;
const GUARDED = { keyId: "key-1", kind: "guarded", name: "neuraldeep" } as const;
const DELIVERED = { kind: "delivered", name: "neuraldeep" } as const;
const CHAT = { first_name: "Owner", id: 101, type: "private" };
const OWNER = { first_name: "Owner", id: 101, is_bot: false };

function rawMessage(text: string): Record<string, unknown> {
  return {
    chat: CHAT,
    date: 1_762_284_762,
    entities: [{ length: text.length, offset: 0, type: "code" }],
    from: OWNER,
    link_preview_options: { is_disabled: true },
    message_id: 55,
    text,
  };
}

function message(text: string, overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    kind: "message",
    message: {
      attachments: [],
      caption: "",
      chat: { id: "101", type: "private" },
      from: { id: "101" } as TelegramMessage["from"],
      messageId: "55",
      raw: rawMessage(text),
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
    isQueued: vi.fn().mockResolvedValue(false),
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
    capture,
    dependencies,
    run: async (update: TelegramUpdate, updateId = "900") => {
      const outcome = await capture(update, updateId, (work) => background.push(work));
      await Promise.all(background);
      return outcome;
    },
  };
}

function replaced(outcome: ApiKeyCapture) {
  if (outcome.kind !== "replaced") throw new Error(`AGENT_TEST_API_KEY_NOT_REPLACED: outcome ${outcome.kind}`);
  if (outcome.update.kind !== "message") throw new Error("AGENT_TEST_API_KEY_UPDATE_KIND: not a message");
  return { raw: outcome.raw, text: outcome.update.message.text, update: outcome.update };
}

describe("API key intake", () => {
  it("stores the key for the wait it was matched to, deletes the message and tells the owner", async () => {
    const { dependencies, run } = setup();

    const outcome = await run(message(`  ${KEY}\n`));

    expect(outcome.kind).toBe("replaced");
    expect(dependencies.find).toHaveBeenCalledWith({ telegramChatId: "101", updateId: "900" });
    expect(dependencies.encrypt).toHaveBeenCalledWith(KEY);
    expect(dependencies.store).toHaveBeenCalledWith({
      expiresAt: EXPIRES_AT, keyId: "key-1", telegramChatId: "101", updateId: "900", value: ENCRYPTED,
    });
    expect(dependencies.publish).toHaveBeenCalledTimes(1);
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    const notice = dependencies.telegram.sendMessage.mock.calls[0]![1] as string;
    expect(notice).toContain("«neuraldeep» сохранён");
    expect(notice).toContain("продолжит");
    expect(notice).not.toContain(KEY);
  });

  it("passes the update on with the application's notice in place of the key", async () => {
    const { run } = setup();

    const { raw, text, update } = replaced(await run(message(KEY)));

    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(raw.update_id).toBe(900);
    expect(parseTelegramUpdate(raw)).toEqual(update);
    expect(text).toContain("neuraldeep");
    expect(text).toContain("NEURALDEEP_API_KEY");
    expect(text).toContain("NEURALDEEP_BASE_URL");
    expect(text).not.toContain("AGENT_API_KEY_PUBLISH_FAILED");
    // Not the owner's words: memory is not searched with it.
    expect(isApiKeyDeliveredModelText(prepareMemoryQuery(text))).toBe(true);
  });

  it("keeps only the message's routing fields in the update that goes on", async () => {
    const { run } = setup();
    const replyTo = { chat: CHAT, date: 1_762_284_700, from: OWNER, message_id: 50, text: `мой старый ${KEY}` };
    const update = message(KEY, {
      raw: {
        ...rawMessage(KEY),
        forward_origin: { date: 1_762_284_000, sender_user: OWNER, type: "user" },
        is_topic_message: true,
        message_thread_id: 7,
        reply_to_message: replyTo,
      },
    });

    const { raw } = replaced(await run(update));

    expect(raw.message).toEqual({
      chat: CHAT,
      date: 1_762_284_762,
      from: OWNER,
      is_topic_message: true,
      message_id: 55,
      message_thread_id: 7,
      // Which message it answers, never that message's words.
      reply_to_message: { chat: CHAT, date: 1_762_284_700, from: OWNER, message_id: 50 },
      text: expect.any(String),
    });
    expect(JSON.stringify(raw)).not.toContain(KEY);
  });

  it("applies the key before the update goes on, so the agent's turn can already use it", async () => {
    const { capture, dependencies } = setup();
    let applied = false;
    dependencies.publish.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        applied = true;
        resolve();
      }, 5);
    }));

    const outcome = await capture(message(KEY), "900", () => undefined);

    expect(outcome.kind).toBe("replaced");
    expect(applied).toBe(true);
  });

  it("says in the notice and to the owner that the stored key could not be applied", async () => {
    const { dependencies, run } = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    dependencies.publish.mockRejectedValue(new Error("disk full"));

    const { raw, text } = replaced(await run(message(KEY)));

    expect(text).toContain("AGENT_API_KEY_PUBLISH_FAILED");
    expect(text).toContain("target=personal");
    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("не применён");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("AGENT_API_KEY_PUBLISH_FAILED"));
    vi.restoreAllMocks();
  });

  it("asks the owner to delete the message when the bot could not", async () => {
    const { dependencies, run } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dependencies.telegram.deleteMessage.mockRejectedValue(new Error("message can't be deleted"));

    expect((await run(message(KEY))).kind).toBe("replaced");

    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("удалите его вручную");
    vi.restoreAllMocks();
  });

  it("withholds a key whose wait closed meanwhile", async () => {
    const { dependencies, run } = setup();
    dependencies.store.mockResolvedValue(false);

    expect(await run(message(KEY))).toEqual({ kind: "consumed" });

    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("уже закончилось");
  });

  it("withholds a key among other words and keeps waiting", async () => {
    const { dependencies, run } = setup();

    expect(await run(message(`вот ключ: ${KEY}`))).toEqual({ kind: "consumed" });

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("только сам ключ");
  });

  it.each(["а где взять ключ?", "https://docs.neuraldeep.ru/api/keys"])(
    "ends the wait on the ordinary message %j and lets it reach the agent",
    async (text) => {
      const { dependencies, run } = setup();

      expect(await run(message(text))).toEqual({ kind: "forwarded" });

      expect(dependencies.cancel).toHaveBeenCalledWith({ keyId: "key-1", telegramChatId: "101" });
      expect(dependencies.store).not.toHaveBeenCalled();
      expect(dependencies.telegram.deleteMessage).not.toHaveBeenCalled();
      expect(dependencies.telegram.sendMessage.mock.calls[0]![1]).toContain("отменено");
    },
  );

  // The guard cannot tell which service a key belongs to: the owner may be sending a key of another
  // service, so the notice must not attribute it to the key whose request opened the guard.
  it.each([KEY, `вот ключ: ${KEY}`])("withholds %j sent within the guard after the wait", async (text) => {
    const { dependencies, run } = setup(GUARDED);

    expect(await run(message(text))).toEqual({ kind: "consumed" });

    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    const notice = dependencies.telegram.sendMessage.mock.calls[0]![1] as string;
    expect(notice).not.toContain(GUARDED.name);
    expect(notice).toContain("агенту не передал");
    expect(notice).toContain("попросите агента запросить");
  });

  it("lets an ordinary message through within the guard, silently", async () => {
    const { dependencies, run } = setup(GUARDED);

    expect(await run(message("спасибо, работает"))).toEqual({ kind: "forwarded" });

    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  // A crash may have come after the key was stored and before the notice was queued.
  it("passes the notice on when a repeated delivery finds it not queued yet", async () => {
    const first = setup();
    const { raw: firstRaw } = replaced(await first.run(message(KEY)));
    const { dependencies, run } = setup(DELIVERED);

    const { raw } = replaced(await run(message(KEY)));

    expect(raw).toEqual(firstRaw);
    expect(dependencies.isQueued).toHaveBeenCalledWith("900");
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.publish).toHaveBeenCalledTimes(1);
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  // The first notice said the key could not be applied; this one would say it works, and the queue
  // refuses a copy that differs, so Telegram would retry the update without end.
  it("only applies the key again and deletes the message when the queue already holds the update", async () => {
    const { dependencies, run } = setup(DELIVERED);
    dependencies.isQueued.mockResolvedValue(true);

    expect(await run(message(KEY))).toEqual({ kind: "consumed" });

    expect(dependencies.publish).toHaveBeenCalledTimes(1);
    expect(dependencies.telegram.deleteMessage).toHaveBeenCalledWith("101", "55");
    expect(dependencies.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("lets a message through when no wait or guard exists", async () => {
    const { dependencies, run } = setup(null);

    expect(await run(message(KEY))).toEqual({ kind: "forwarded" });

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

    expect(await run(update)).toEqual({ kind: "forwarded" });

    expect(dependencies.find).not.toHaveBeenCalled();
  });
});
