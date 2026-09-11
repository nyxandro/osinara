/** Compose a private album through Eve's public attachment-array contract, preserving raw sources. */
import { parseTelegramUpdate, type TelegramMessage, type TelegramUpdate } from "eve/channels/telegram";
import { AppError } from "./app-error.js";
import { TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE } from "../config.js";
import type { TelegramWorkspaceAttachment } from "./attachments/telegram-workspace-attachments.js";

// Telegram sends no album-complete event. Each new member extends this durable quiet window;
// the existing five-second drain poll also covers a process restart during collection.
export const TELEGRAM_MEDIA_GROUP_QUIET_MS = 2_000;

function invalidGroup(): never {
  throw new AppError("AGENT_TELEGRAM_MEDIA_GROUP_INVALID",
    "Не удалось собрать файлы одного сообщения. Отправьте файлы с подписью заново");
}

export function privateTelegramMediaGroupKey(payload: Record<string, unknown>): string | null {
  const update = parseTelegramUpdate(payload);
  if (update?.kind !== "message" || update.message.chat.type !== "private") return null;
  const key = update.message.raw.media_group_id;
  if (key === undefined) return null;
  if (typeof key !== "string" || !key.trim()) {
    return invalidGroup();
  }
  return key;
}

export function combineTelegramMediaGroup(payloads: readonly Record<string, unknown>[]): TelegramUpdate {
  if (!payloads.length || payloads.length > TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE) return invalidGroup();
  let key: string | null = null;
  const messages: TelegramMessage[] = [];
  for (const payload of payloads) {
    const currentKey = privateTelegramMediaGroupKey(payload);
    const parsed = parseTelegramUpdate(payload);
    if (!currentKey || parsed?.kind !== "message") return invalidGroup();
    const first = messages[0];
    const message = parsed.message;
    if (!message.from || message.attachments.length !== 1) return invalidGroup();
    if (first && (currentKey !== key || message.chat.id !== first.chat.id ||
      message.from?.id !== first.from?.id || message.from?.isBot !== first.from?.isBot ||
      message.messageThreadId !== first.messageThreadId)) return invalidGroup();
    key = currentKey;
    messages.push(message);
  }
  // Use a real caption-bearing message as the reply/source anchor, not invented Telegram metadata.
  const anchor = messages.find(message => message.caption.trim() || message.text.trim()) ?? messages[0]!;
  return { kind: "message", message: {
    ...anchor,
    attachments: messages.flatMap(message => message.attachments.map((attachment): TelegramWorkspaceAttachment => ({
      ...attachment, telegramMessageId: message.messageId,
    }))),
    caption: messages.map(message => message.caption).filter(text => text.trim()).join("\n\n"),
    text: messages.map(message => message.text).filter(text => text.trim()).join("\n\n"),
  } };
}
