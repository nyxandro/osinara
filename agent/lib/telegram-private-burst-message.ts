/**
 * One private-chat burst as one model-facing message.
 *
 * Exports:
 * - `TelegramBurstCandidate`: a pending update of the chat queue with what a running turn saw of it.
 * - `selectTelegramBurstMembers`: the followers that join a head, in order.
 * - `combineTelegramBurst`: the head and its followers as one Telegram message.
 *
 * Key constructs:
 * - A burst is answered as one request: every part is the current message, so the model may act on
 *   and remember any of them, exactly like the photos of one album.
 * - Only plain messages join. A voice note needs its own transcription, an album is already one
 *   message, a command acts alone, a reply to the bot may answer a pending confirmation, and a
 *   message a running turn already saw carries its own notice. Each of them stays a turn of its own.
 * - The followers stop at the first message that cannot join, so the chat's order is kept.
 */
import { parseTelegramUpdate, type TelegramMessage, type TelegramUpdate } from "eve/channels/telegram";

import { TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE } from "../config.js";
import { AppError } from "./app-error.js";
import type { TelegramWorkspaceAttachment } from "./attachments/telegram-workspace-attachments.js";
import type { TelegramPrivateBurstPolicy } from "./telegram-ingress-contract.js";
import { telegramInboundText } from "./telegram-group-message-storage.js";
import { isTelegramSlashCommand } from "./telegram-message-policy.js";

export interface TelegramBurstCandidate {
  /** Whether a running turn of this chat already saw this message with a tool result. */
  delivered: boolean;
  payload: Record<string, unknown>;
  updateId: string;
}

const PART_SEPARATOR = "\n\n";

function burstMessage(candidate: TelegramBurstCandidate): TelegramMessage | null {
  if (candidate.delivered) return null;
  const update = parseTelegramUpdate(candidate.payload);
  if (update?.kind !== "message") return null;
  const message = update.message;
  const raw = message.raw;
  if (message.chat.type !== "private" || Object.hasOwn(raw, "voice") || raw.media_group_id !== undefined) return null;
  if (message.replyToMessage?.from?.isBot === true) return null;
  const text = telegramInboundText(message);
  if (!text && message.attachments.length === 0) return null;
  if (isTelegramSlashCommand(text)) return null;
  return message;
}

function partText(message: TelegramMessage): string {
  return telegramInboundText(message);
}

export function selectTelegramBurstMembers(
  head: TelegramBurstCandidate,
  followers: readonly TelegramBurstCandidate[],
  limits: Pick<TelegramPrivateBurstPolicy, "maxCharacters" | "maxMessages">,
): string[] {
  const leader = burstMessage(head);
  if (!leader) return [];
  let characters = partText(leader).length;
  let attachments = leader.attachments.length;
  const members: string[] = [];
  for (const follower of followers) {
    if (members.length + 1 >= limits.maxMessages) break;
    const message = burstMessage(follower);
    if (!message) break;
    const nextCharacters = characters + PART_SEPARATOR.length + partText(message).length;
    const nextAttachments = attachments + message.attachments.length;
    if (nextCharacters > limits.maxCharacters || nextAttachments > TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE) break;
    characters = nextCharacters;
    attachments = nextAttachments;
    members.push(follower.updateId);
  }
  return members;
}

export function combineTelegramBurst(payloads: readonly Record<string, unknown>[]): TelegramUpdate {
  const messages = payloads.map((payload) => {
    const update = parseTelegramUpdate(payload);
    if (update?.kind !== "message") {
      throw new AppError(
        "AGENT_TELEGRAM_BURST_INVALID",
        "Не удалось собрать несколько сообщений подряд в одно. Отправьте их ещё раз",
      );
    }
    return update.message;
  });
  const head = messages[0];
  if (!head) {
    throw new AppError("AGENT_TELEGRAM_BURST_INVALID", "Не удалось собрать несколько сообщений подряд в одно. Отправьте их ещё раз");
  }
  // The head stays the real anchor: its id, chat, sender and reply target, never invented metadata.
  // Its rich text is already a part of the combined text and must not be read a second time.
  const { rich_message: _richMessage, ...raw } = head.raw;
  return {
    kind: "message",
    message: {
      ...head,
      raw,
      attachments: messages.flatMap((message) => message.attachments.map((attachment): TelegramWorkspaceAttachment => ({
        ...attachment,
        telegramMessageId: message.messageId,
      }))),
      caption: "",
      text: messages.map(partText).filter(Boolean).join(PART_SEPARATOR),
    },
  };
}
