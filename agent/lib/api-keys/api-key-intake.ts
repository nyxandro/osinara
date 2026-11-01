/**
 * Capture of an API key from the owner's private message, before the message is queued.
 *
 * Exports:
 * - `API_KEY_INTAKE_MINUTES`, `API_KEY_INTAKE_GUARD_HOURS`: how long a key is awaited, and how long
 *   after that a key sent anyway is still kept from the model.
 * - `ApiKeyIntakeDependencies`: storage, encryption, publication and Telegram.
 * - `createApiKeyIntake`: decides whether a verified update is the awaited key and consumes it.
 * - `captureApiKeyMessage`: the production capture used by the Telegram webhook.
 *
 * Only a text message of the owner's private chat with a wait or its guard is inspected. While the
 * wait is open the key is stored; a key among other words is withheld; any other message ends the
 * wait and goes to the agent. Within the guard every key-like message is withheld, so a key sent
 * late, after "I'll look for it", or a second time never reaches the queue, the history or the model.
 */
import type { TelegramUpdate } from "../../runtime/telegram/inbound.js";
import type { ApiKeyEncryptedValue } from "./api-key-contract.js";
import { encryptApiKeyValue, INTEGRATION_KEY_ENVIRONMENT_NAME } from "./api-key-crypto.js";
import { classifyApiKeyMessage } from "./api-key-message.js";
import { apiKeyPublisher } from "./api-key-projection.js";
import { apiKeyRepository } from "./api-key-repository.js";
import { apiKeyTelegram } from "./api-key-telegram.js";

export const API_KEY_INTAKE_MINUTES = 30;
export const API_KEY_INTAKE_GUARD_HOURS = 24;

export interface ApiKeyIntakeDependencies {
  cancel: typeof apiKeyRepository.cancelIntake;
  encrypt(value: string): ApiKeyEncryptedValue;
  find: typeof apiKeyRepository.findIntake;
  publish(): Promise<void>;
  store: typeof apiKeyRepository.storeValue;
  telegram: {
    deleteMessage(chatId: string, messageId: string): Promise<void>;
    sendMessage(chatId: string, text: string): Promise<void>;
  };
}

type WaitUntil = (work: Promise<unknown>) => void;

function storedNotice(name: string, deleted: boolean, applied: boolean): string {
  return [
    `✅ Ключ «${name}» сохранён и зашифрован. Агент его не видел.`,
    deleted
      ? "Сообщение с ключом удалено из чата."
      : "⚠️ Не удалось удалить сообщение с ключом — удалите его вручную.",
    applied
      ? "Ключ уже работает в вашем личном чате. Чтобы дать его семье или группе, попросите агента."
      : "⚠️ Ключ пока не применён: попросите агента показать список ключей и выдать ключ ещё раз (код AGENT_API_KEY_PUBLISH_FAILED).",
  ].join("\n\n");
}

function endedNotice(name: string): string {
  return `Ожидание ключа «${name}» уже закончилось, поэтому сообщение я удалил, не сохранил и агенту не передал. Если нужно сохранить ключ, попросите агента запросить его заново.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const confirmStored = async (chatId: string, messageId: string, name: string): Promise<void> => {
    const removed = await deleted(chatId, messageId);
    let applied = true;
    try {
      await dependencies.publish();
    } catch (error) {
      applied = false;
      console.error(JSON.stringify({ code: "AGENT_API_KEY_PUBLISH_FAILED", error: errorText(error), name }));
    }
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

  return async function capture(update: TelegramUpdate, updateId: string, waitUntil: WaitUntil): Promise<boolean> {
    if (update.kind !== "message") return false;
    const message = update.message;
    if (
      message.chat.type !== "private" || message.from?.id !== message.chat.id ||
      !message.text || message.caption || message.attachments.length > 0
    ) {
      return false;
    }
    const chatId = message.chat.id;
    const intake = await dependencies.find({ telegramChatId: chatId, updateId });
    if (intake === null) return false;
    if (intake.kind === "delivered") {
      console.info(JSON.stringify({ code: "AGENT_API_KEY_INTAKE_REDELIVERED", updateId }));
      waitUntil(deleteAgain(chatId, message.messageId));
      return true;
    }

    const text = classifyApiKeyMessage(message.text);
    if (intake.kind === "guarded") {
      if (text.kind === "ordinary") return false;
      console.info(JSON.stringify({ code: "AGENT_API_KEY_LATE_MESSAGE_WITHHELD", name: intake.name }));
      waitUntil(withhold(chatId, message.messageId, endedNotice(intake.name)));
      return true;
    }
    if (text.kind === "key") {
      const stored = await dependencies.store({
        expiresAt: intake.expiresAt,
        keyId: intake.keyId,
        telegramChatId: chatId,
        updateId,
        value: dependencies.encrypt(text.value),
      });
      console.info(JSON.stringify({ code: stored ? "AGENT_API_KEY_VALUE_STORED" : "AGENT_API_KEY_INTAKE_CLOSED", name: intake.name }));
      waitUntil(stored
        ? confirmStored(chatId, message.messageId, intake.name)
        : withhold(chatId, message.messageId, endedNotice(intake.name)));
      return true;
    }
    if (text.kind === "secret") {
      waitUntil(withhold(chatId, message.messageId,
        `В сообщении похоже был ключ вместе с другим текстом, поэтому я его удалил и агенту не передал. Пришлите только сам ключ, без других слов — жду ключ «${intake.name}».`));
      return true;
    }
    await dependencies.cancel({ keyId: intake.keyId, telegramChatId: chatId });
    waitUntil(notify(chatId, `Ожидание ключа «${intake.name}» отменено: сообщение не похоже на ключ, передаю его агенту.`));
    return false;
  };
}

export const captureApiKeyMessage = createApiKeyIntake({
  cancel: (input) => apiKeyRepository.cancelIntake(input),
  encrypt: (value) => encryptApiKeyValue(value, process.env[INTEGRATION_KEY_ENVIRONMENT_NAME]),
  find: (input) => apiKeyRepository.findIntake(input),
  publish: () => apiKeyPublisher.publish(),
  store: (input) => apiKeyRepository.storeValue(input),
  telegram: apiKeyTelegram,
});
