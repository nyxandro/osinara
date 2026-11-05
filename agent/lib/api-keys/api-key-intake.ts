/**
 * Capture of an API key from the owner's private message, before the message is queued.
 *
 * Exports:
 * - `API_KEY_INTAKE_MINUTES`, `API_KEY_INTAKE_GUARD_HOURS`: how long a key is awaited, and how long
 *   after that a key sent anyway is still kept from the model.
 * - `ApiKeyIntakeDependencies`: storage, encryption, publication and Telegram.
 * - `ApiKeyCapture`: what the webhook does with the update next.
 * - `createApiKeyIntake`: decides whether a verified update is the awaited key and takes the key out.
 * - `captureApiKeyMessage`: the production capture used by the Telegram webhook.
 *
 * Only a text message of the owner's private chat with a wait or its guard is inspected. While the
 * wait is open the key is stored; a key among other words is withheld; any other message ends the
 * wait and goes to the agent. Within the guard every key-like message is withheld, so a key sent
 * late, after "I'll look for it", or a second time never reaches the queue, the history or the model.
 *
 * Key constructs:
 * - A stored key's message still goes on to the agent, so the task that waited for the key goes on
 *   without the owner having to say the key was sent: the application's notice replaces the key,
 *   and of the message only the fields that route it are kept.
 * - The key is applied to the proxy before the message goes on, so the agent's turn can use it.
 * - Telegram sending the same update again applies the key again. An update the queue already holds
 *   is not offered again: its notice may say otherwise about applying, and the queue refuses a copy
 *   that differs. One the first delivery never queued brings the agent its notice now.
 */
import { isObject, parseJsonObject, type JsonObject } from "../../runtime/json.js";
import { parseTelegramUpdate, type TelegramMessage, type TelegramUpdate } from "../../runtime/telegram/inbound.js";
import { isTelegramUpdateQueued } from "../telegram-ingress-repository.js";
import { apiKeyDeliveredModelText } from "../telegram-model-placeholders.js";
import { apiKeyEnvironmentNames, type ApiKeyEncryptedValue } from "./api-key-contract.js";
import { encryptApiKeyValue, API_KEY_ENCRYPTION_KEY_ENVIRONMENT_NAME } from "./api-key-crypto.js";
import { classifyApiKeyMessage } from "./api-key-message.js";
import { apiKeyPublisher } from "./api-key-projection.js";
import { apiKeyRepository } from "./api-key-repository.js";
import { apiKeyTelegram } from "./api-key-telegram.js";

export const API_KEY_INTAKE_MINUTES = 30;
export const API_KEY_INTAKE_GUARD_HOURS = 24;

// What the queue needs to route a message as the owner's own: its chat, topic and author. Nothing
// that carries a message's content is copied, so the key cannot ride along.
const ROUTING_FIELDS = ["chat", "date", "from", "is_topic_message", "message_id", "message_thread_id"] as const;

export interface ApiKeyIntakeDependencies {
  cancel: typeof apiKeyRepository.cancelIntake;
  encrypt(value: string): ApiKeyEncryptedValue;
  find: typeof apiKeyRepository.findIntake;
  /** Whether the chat queue already holds the update. */
  isQueued(updateId: string): Promise<boolean>;
  publish(): Promise<void>;
  store: typeof apiKeyRepository.storeValue;
  telegram: {
    deleteMessage(chatId: string, messageId: string): Promise<void>;
    sendMessage(chatId: string, text: string): Promise<void>;
  };
}

export type ApiKeyCapture =
  /** Not the intake's message: it goes on to the agent unchanged. */
  | { readonly kind: "forwarded" }
  /** Withheld: nothing of it reaches the queue. */
  | { readonly kind: "consumed" }
  /** The stored key's message goes on with the application's notice in place of the key. */
  | { readonly kind: "replaced"; readonly raw: JsonObject; readonly update: TelegramUpdate };

const FORWARDED: ApiKeyCapture = { kind: "forwarded" };
const CONSUMED: ApiKeyCapture = { kind: "consumed" };

type WaitUntil = (work: Promise<unknown>) => void;

function storedNotice(name: string, deleted: boolean, applied: boolean): string {
  return [
    `✅ Ключ «${name}» сохранён и зашифрован. Агент его не видел.`,
    deleted
      ? "Сообщение с ключом удалено из чата."
      : "⚠️ Не удалось удалить сообщение с ключом — удалите его вручную.",
    applied
      ? "Ключ уже работает в вашем личном чате, агент узнает об этом и продолжит. Чтобы дать ключ семье или группе, попросите агента."
      : "⚠️ Ключ пока не применён (код AGENT_API_KEY_PUBLISH_FAILED). Агент узнает об этом и попробует применить его заново.",
  ].join("\n\n");
}

function endedNotice(name: string): string {
  return `Ожидание ключа «${name}» уже закончилось, поэтому сообщение я удалил, не сохранил и агенту не передал. Если нужно сохранить ключ, попросите агента запросить его заново.`;
}

// Within the guard nothing tells which service a key-like message is for, so no key is named.
const GUARDED_NOTICE =
  "Сообщение похоже на ключ, поэтому я удалил его и агенту не передал: ключи принимаются только в ответ на запрос. Чтобы сохранить ключ, попросите агента запросить его и пришлите ключ следующим сообщением.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function routingFields(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(ROUTING_FIELDS.map((field) => [field, raw[field]]));
}

function noticeInPlaceOfKey(message: TelegramMessage, updateId: string, name: string, applied: boolean): ApiKeyCapture {
  const reply = message.raw.reply_to_message;
  const routing = {
    ...routingFields(message.raw),
    // A reply keeps which message it answers, never that message's words: they may hold a key too.
    ...(isObject(reply) ? { reply_to_message: routingFields(reply) } : {}),
  };
  const text = apiKeyDeliveredModelText({ applied, name, variables: apiKeyEnvironmentNames(name) });
  // Absent fields are dropped here, so the update reads exactly as Telegram would have sent it.
  const raw = parseJsonObject({ message: { ...routing, text }, update_id: Number(updateId) });
  const update = parseTelegramUpdate(raw);
  if (update === null) {
    throw new Error("AGENT_API_KEY_NOTICE_INVALID: the notice in place of the key is not a Telegram update");
  }
  return { kind: "replaced", raw, update };
}

export function createApiKeyIntake(dependencies: ApiKeyIntakeDependencies) {
  const notify = async (chatId: string, text: string): Promise<void> => {
    try {
      await dependencies.telegram.sendMessage(chatId, text);
    } catch (error) {
      console.error(JSON.stringify({ code: "AGENT_API_KEY_NOTICE_FAILED", error: errorText(error) }));
    }
  };

  const deleted = async (chatId: string, messageId: string): Promise<boolean> => {
    try {
      await dependencies.telegram.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      console.error(JSON.stringify({ code: "AGENT_API_KEY_MESSAGE_DELETE_FAILED", error: errorText(error) }));
      return false;
    }
  };

  // A failure is said to the owner and, in the notice, to the agent, which can apply the key again.
  const apply = async (name: string): Promise<boolean> => {
    try {
      await dependencies.publish();
      return true;
    } catch (error) {
      console.error(JSON.stringify({ code: "AGENT_API_KEY_PUBLISH_FAILED", error: errorText(error), name }));
      return false;
    }
  };

  const confirmStored = async (chatId: string, messageId: string, name: string, applied: boolean): Promise<void> => {
    const removed = await deleted(chatId, messageId);
    await notify(chatId, storedNotice(name, removed, applied));
  };

  const withhold = async (chatId: string, messageId: string, text: string): Promise<void> => {
    const removed = await deleted(chatId, messageId);
    await notify(chatId, removed ? text : `${text}\n\n⚠️ Не удалось удалить это сообщение — удалите его вручную.`);
  };

  // A crash after storing may have left the message in the chat; it is deleted again, quietly.
  const deleteAgain = async (chatId: string, messageId: string): Promise<void> => {
    try {
      await dependencies.telegram.deleteMessage(chatId, messageId);
    } catch (error) {
      console.info(JSON.stringify({ code: "AGENT_API_KEY_REDELIVERY_DELETE_SKIPPED", error: errorText(error) }));
    }
  };

  return async function capture(update: TelegramUpdate, updateId: string, waitUntil: WaitUntil): Promise<ApiKeyCapture> {
    if (update.kind !== "message") return FORWARDED;
    const message = update.message;
    if (
      message.chat.type !== "private" || message.from?.id !== message.chat.id ||
      !message.text || message.caption || message.attachments.length > 0
    ) {
      return FORWARDED;
    }
    const chatId = message.chat.id;
    const intake = await dependencies.find({ telegramChatId: chatId, updateId });
    if (intake === null) return FORWARDED;
    if (intake.kind === "delivered") {
      // The first delivery may have stopped before the key was applied or the notice was queued.
      console.info(JSON.stringify({ code: "AGENT_API_KEY_INTAKE_REDELIVERED", updateId }));
      const applied = await apply(intake.name);
      waitUntil(deleteAgain(chatId, message.messageId));
      return await dependencies.isQueued(updateId) ? CONSUMED : noticeInPlaceOfKey(message, updateId, intake.name, applied);
    }

    const text = classifyApiKeyMessage(message.text);
    if (intake.kind === "guarded") {
      if (text.kind === "ordinary") return FORWARDED;
      console.info(JSON.stringify({ code: "AGENT_API_KEY_LATE_MESSAGE_WITHHELD", name: intake.name }));
      waitUntil(withhold(chatId, message.messageId, GUARDED_NOTICE));
      return CONSUMED;
    }
    if (text.kind === "key") {
      const stored = await dependencies.store({
        expiresAt: intake.expiresAt,
        keyId: intake.keyId,
        telegramChatId: chatId,
        updateId,
        value: dependencies.encrypt(text.value),
      });
      if (!stored) {
        console.info(JSON.stringify({ code: "AGENT_API_KEY_INTAKE_CLOSED", name: intake.name }));
        waitUntil(withhold(chatId, message.messageId, endedNotice(intake.name)));
        return CONSUMED;
      }
      console.info(JSON.stringify({ code: "AGENT_API_KEY_VALUE_STORED", name: intake.name }));
      const applied = await apply(intake.name);
      const notice = noticeInPlaceOfKey(message, updateId, intake.name, applied);
      waitUntil(confirmStored(chatId, message.messageId, intake.name, applied));
      return notice;
    }
    if (text.kind === "secret") {
      waitUntil(withhold(chatId, message.messageId,
        `В сообщении похоже был ключ вместе с другим текстом, поэтому я его удалил и агенту не передал. Пришлите только сам ключ, без других слов — жду ключ «${intake.name}».`));
      return CONSUMED;
    }
    await dependencies.cancel({ keyId: intake.keyId, telegramChatId: chatId });
    waitUntil(notify(chatId, `Ожидание ключа «${intake.name}» отменено: сообщение не похоже на ключ, передаю его агенту.`));
    return FORWARDED;
  };
}

export const captureApiKeyMessage = createApiKeyIntake({
  cancel: (input) => apiKeyRepository.cancelIntake(input),
  encrypt: (value) => encryptApiKeyValue(value, process.env[API_KEY_ENCRYPTION_KEY_ENVIRONMENT_NAME]),
  find: (input) => apiKeyRepository.findIntake(input),
  isQueued: (updateId) => isTelegramUpdateQueued(updateId),
  publish: () => apiKeyPublisher.publish(),
  store: (input) => apiKeyRepository.storeValue(input),
  telegram: apiKeyTelegram,
});
