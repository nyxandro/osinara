/**
 * What a person sent that never reached the agent, and the note the agent answers them from.
 *
 * Exports:
 * - `UnreceivedTelegramFile`: a photo, file or GIF of a message whose content the agent cannot see.
 * - `unreceivedFileReason`: which failures of an attachment mean its file did not come through.
 * - `unreceivedVoiceReason`: the same for a voice message addressed to the agent.
 * - `UNRECEIVED_VOICE_FIELD`, `withUnreceivedVoice`, `unreceivedVoiceOf`: carry a voice message's
 *   reason from ingress to its turn.
 * - `formatUnreceivedFile`, `formatUnreceivedVoice`: the turn notes.
 *
 * Key construct:
 * - The owner's decision of 16.11.2026: such a failure reaches only the person who sent the file, in
 *   the agent's own words, without codes. The message is not failed and nothing goes to the owner;
 *   the log keeps every case for the on-call agent.
 */
import type { TelegramAttachment, TelegramMessage } from "../runtime/telegram/inbound.js";

import { AppError, isAppError } from "./app-error.js";

export type UnreceivedFileReason =
  /** A GIF came in, but no frame could be taken from its file. */
  | "picture_unavailable"
  /** Telegram did not hand the file over, or handed over something broken. */
  | "telegram_failure"
  /** Over the 20 MB Telegram lets a bot receive. */
  | "too_large";

export interface UnreceivedTelegramFile {
  kind: TelegramAttachment["kind"];
  telegramMessageId: string;
  unreceived: UnreceivedFileReason;
}

export type UnreceivedVoiceReason =
  /** An earlier attempt to make out the words stopped half-way; it is not repeated, to never pay twice. */
  | "interrupted"
  /** This server has speech recognition switched off. */
  | "recognition_off"
  | "recognition_unavailable"
  | "speech_unrecognized"
  | "telegram_failure"
  | "too_large";

const UNRECEIVED_VOICE_REASONS: ReadonlySet<string> = new Set<UnreceivedVoiceReason>([
  "interrupted",
  "recognition_off",
  "recognition_unavailable",
  "speech_unrecognized",
  "telegram_failure",
  "too_large",
]);

// How Node's fetch reports a lost connection; such a TypeError is the transfer failing, not a defect.
const FETCH_CONNECTION_FAILURE_MESSAGES = new Set(["fetch failed", "terminated"]);

/** A fault of the server's own code: it fails the message as before and is never told as Telegram's. */
function isCodeDefect(error: unknown): boolean {
  if (error instanceof ReferenceError) return true;
  return error instanceof TypeError && !FETCH_CONNECTION_FAILURE_MESSAGES.has(error.message);
}

/** An application field beside Telegram's own: Telegram never sends it, the ingress writes it. */
export const UNRECEIVED_VOICE_FIELD = "osinara_unreceived_voice";

const FILE_NAMES: Readonly<Record<TelegramAttachment["kind"], string>> = {
  animation: "GIF",
  document: "file",
  photo: "photo",
};

/** The reason a failed attachment did not come through, or null for a fault that must fail the message. */
export function unreceivedFileReason(error: unknown): Exclude<UnreceivedFileReason, "picture_unavailable"> | null {
  if (!isAppError(error)) return null;
  switch (error.code) {
    case "AGENT_ATTACHMENT_DOWNLOAD_FAILED":
    case "AGENT_ATTACHMENT_DOWNLOAD_RESPONSE_INVALID":
    // Telegram's photo transport carried bytes that are not a picture: a broken transfer.
    case "AGENT_ATTACHMENT_TYPE_MISMATCH":
      return "telegram_failure";
    case "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE":
      return "too_large";
    default:
      return null;
  }
}

/**
 * Why a voice message addressed to the agent has no words, or null for a fault of the server's own
 * code. Anything else that is not a verdict on the recording itself is speech recognition failing:
 * the person's answer is the same, write it as text.
 */
export function unreceivedVoiceReason(error: unknown): UnreceivedVoiceReason | null {
  if (isCodeDefect(error)) return null;
  if (!isAppError(error)) return "recognition_unavailable";
  switch (error.code) {
    case "AGENT_VOICE_TRANSCRIPTION_RECOVERY_REQUIRED":
      return "interrupted";
    case "AGENT_VOICE_NOT_CONFIGURED":
      return "recognition_off";
    case "AGENT_VOICE_DOWNLOAD_FAILED":
    case "AGENT_VOICE_CONTENT_INVALID":
      return "telegram_failure";
    case "AGENT_VOICE_FILE_TOO_LARGE":
      return "too_large";
    case "AGENT_VOICE_MEDIA_TYPE_UNSUPPORTED":
    case "AGENT_VOICE_TRANSCRIPT_EMPTY":
      return "speech_unrecognized";
    default:
      return "recognition_unavailable";
  }
}

/** The stored update with its voice message marked as unreceived, as a transcript is written in. */
export function withUnreceivedVoice(payload: Record<string, unknown>, reason: UnreceivedVoiceReason): Record<string, unknown> {
  const cloned = structuredClone(payload);
  const message = cloned.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_INVALID",
      "Telegram передал неполные данные голосового сообщения. Запишите и отправьте его заново",
    );
  }
  (message as Record<string, unknown>)[UNRECEIVED_VOICE_FIELD] = reason;
  return cloned;
}

export function unreceivedVoiceOf(message: Pick<TelegramMessage, "raw">): UnreceivedVoiceReason | null {
  const value = message.raw?.[UNRECEIVED_VOICE_FIELD];
  return typeof value === "string" && UNRECEIVED_VOICE_REASONS.has(value) ? value as UnreceivedVoiceReason : null;
}

const AGAIN_LATER = "If it already failed like this earlier in this chat, say it failed again and suggest trying a bit later.";

export function formatUnreceivedFile(file: UnreceivedTelegramFile): string {
  const name = FILE_NAMES[file.kind];
  const subject = `The ${name} of Telegram message ${file.telegramMessageId}`;
  switch (file.unreceived) {
    // Named per message: without it the model blamed Telegram and asked to resend a GIF that never
    // carries a picture (03.11.2026).
    case "picture_unavailable":
      return `You cannot see the GIF of Telegram message ${file.telegramMessageId}: the server could not take a frame from its file. ` +
        "Tell the person so plainly; do not guess what it shows or why it failed.";
    case "telegram_failure":
      return `${subject} did not reach you: Telegram did not hand its file over to the bot, a failure on Telegram's side. ` +
        `In your own words, without codes or technical terms, tell the person that Telegram is glitching and the ${name} did not come through, ` +
        `and ask them to send it again. ${AGAIN_LATER} Do not guess what it contains.`;
    case "too_large":
      return `${subject} did not reach you: it is larger than the 20 MB Telegram lets a bot receive. ` +
        "In your own words, tell the person so and suggest a smaller file, a few parts or a link. Do not guess what it contains.";
  }
}

export function formatUnreceivedVoice(reason: UnreceivedVoiceReason): string {
  switch (reason) {
    case "telegram_failure":
      return "The voice message did not reach you: Telegram did not hand its recording over to the bot, a failure on Telegram's side. " +
        "In your own words, without codes or technical terms, tell the person that Telegram is glitching and the voice message did not come through, " +
        `and ask them to send it again or write it as text. ${AGAIN_LATER} Do not guess what it says.`;
    case "too_large":
      return "The voice message did not reach you: it is larger than the 20 MB Telegram lets a bot receive. " +
        "In your own words, ask the person for a shorter recording or text. Do not guess what it says.";
    case "speech_unrecognized":
      return "No speech could be made out in the voice message. " +
        "In your own words, ask the person to record it again or write it as text. Do not guess what it says.";
    case "interrupted":
      return "The voice message could not be made out this time. " +
        "In your own words, without codes or technical terms, ask the person to send it again or write it as text. Do not guess what it says.";
    case "recognition_off":
      return "Voice messages are not turned into text here, so you do not know what this voice message says. " +
        "In your own words, ask the person to write it as text; do not suggest trying again later. Do not guess what it says.";
    case "recognition_unavailable":
      return "Speech recognition did not work, so you do not know what the voice message says. " +
        "In your own words, without names of services, tell the person that voice messages cannot be made out right now " +
        "and ask them to write it as text or try a bit later. Do not guess what it says.";
  }
}
