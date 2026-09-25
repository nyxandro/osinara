/**
 * Collects the chat messages that arrived while the current turn works.
 *
 * Exports:
 * - `TurnInterjectionCollectorDependencies`: queue access, voice authorization and transcription.
 * - `createTurnInterjectionCollector`: builds the per-call lookup and release used by the tool wrapper.
 *
 * Key constructs:
 * - A message is shown only when its own later processing lands in this same conversation and starts
 *   an ordinary turn there; a reply that answers or meets a pending confirmation waits as before.
 * - A message is claimed for this tool call before any paid work, so parallel calls of one step never
 *   transcribe the same recording and the message reaches the model once.
 * - Voice follows the ordinary path's rule: the call is marked as started before Groq is paid, and an
 *   interrupted call is never repeated. A recording that cannot be transcribed now becomes a notice.
 * - Anything failing after the claim releases it, so the result goes back without a block and the
 *   message is neither lost to later calls nor reported to its own turn as already seen.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import type { ToolContext } from "eve/tools";

import { AppError } from "../app-error.js";
import type { TelegramVoiceFile } from "../groq-voice-transcription.js";
import { groupCanonicalContinuationToken } from "../sessions/group-canonical-token.js";
import { telegramInboundText } from "../telegram-group-message-storage.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  isTelegramSlashCommand,
} from "../telegram-message-policy.js";
import { telegramBaseContinuationToken } from "../telegram-reply-routing.js";
import {
  formatTurnInterjectionBlock,
  type TurnInterjectionAttachment,
  type TurnInterjectionEntry,
} from "./turn-interjection-block.js";
import {
  TURN_INTERJECTION_CANDIDATE_LIMIT,
  TURN_INTERJECTION_MAX_MESSAGES,
  TURN_INTERJECTION_MAX_TEXT_CHARACTERS,
  TURN_INTERJECTION_MAX_TRANSCRIPTIONS_PER_CALL,
} from "./turn-interjection-config.js";
import type {
  TurnInterjectionCandidate,
  TurnInterjectionContentKind,
  TurnInterjectionShowCoordinate,
  turnInterjectionRepository,
} from "./turn-interjection-repository.js";
import { resolveTurnInterjectionScope, type TurnInterjectionScope } from "./turn-interjection-scope.js";
import type { TurnInterjection } from "./turn-interjection-tool.js";

export interface TurnInterjectionCollectorDependencies {
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  /** Required only for group chats, where addressing depends on the bot's username. */
  botUsername: string | undefined;
  repository: Pick<
    typeof turnInterjectionRepository,
    | "beginEarlyVoiceTranscription"
    | "claim"
    | "isReplyToPendingConfirmation"
    | "listCandidates"
    | "markReturned"
    | "releaseCall"
    | "routeSessionId"
    | "saveEarlyVoiceTranscript"
  >;
  transcribeVoice(voice: TelegramVoiceFile): Promise<string>;
}

// Checked in order: an animation also carries a `document` field.
const ATTACHMENT_FIELDS: readonly Exclude<TurnInterjectionAttachment, "other">[] = [
  "photo", "video", "video_note", "animation", "audio", "sticker", "document", "location", "contact", "poll",
];

type Plan =
  | { contentKind: "notice" | "text"; entry: TurnInterjectionEntry; updateId: string }
  | {
      contentKind: "voice";
      sentAt: string | null;
      transcript: string | null;
      updateId: string;
      voice: NonNullable<TurnInterjectionCandidate["voice"]>;
    };

interface Collection {
  coordinate: TurnInterjectionShowCoordinate & { applicationSessionId: string };
  dependencies: TurnInterjectionCollectorDependencies;
  routes: Map<string, Promise<string | null>>;
  scope: TurnInterjectionScope;
  signal: AbortSignal | undefined;
  transcriptions: number;
}

function sentAt(message: TelegramMessage): string | null {
  const date = message.raw.date;
  return typeof date === "number" && Number.isSafeInteger(date) ? new Date(date * 1_000).toISOString() : null;
}

function bounded(text: string): { text: string; truncated: boolean } {
  return text.length > TURN_INTERJECTION_MAX_TEXT_CHARACTERS
    ? { text: text.slice(0, TURN_INTERJECTION_MAX_TEXT_CHARACTERS), truncated: true }
    : { text, truncated: false };
}

function attachmentKind(message: TelegramMessage): TurnInterjectionAttachment {
  return ATTACHMENT_FIELDS.find((field) => Object.hasOwn(message.raw, field)) ?? "other";
}

function requireBotUsername(botUsername: string | undefined): string {
  if (!botUsername) throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задано имя Telegram-бота");
  return botUsername;
}

function addressed(message: TelegramMessage, text: string, collection: Collection): boolean {
  if (collection.scope.chatType === "private") return true;
  return isMessageAddressedToBot({ ...message, text }, requireBotUsername(collection.dependencies.botUsername));
}

/**
 * Mirrors the ordinary routing: a private message follows its own continuation route, including a
 * reply to a message this conversation delivered; a family-group message goes to the group's
 * canonical conversation. A reply that belongs to the confirmation flow never starts a turn.
 */
async function landsInThisConversation(message: TelegramMessage, collection: Collection): Promise<boolean> {
  const reply = message.replyToMessage;
  if (reply !== undefined && reply.from?.isBot !== false && await collection.dependencies.repository.isReplyToPendingConfirmation({
    replyMessageId: reply.messageId,
    replyRouteToken: telegramBaseContinuationToken(message),
    telegramChatId: collection.scope.telegramChatId,
  })) return false;
  const { scope } = collection;
  const token = scope.groupId === null
    ? telegramBaseContinuationToken(message)
    : groupCanonicalContinuationToken(scope.groupId, scope.telegramForumTopicId);
  let route = collection.routes.get(token);
  if (route === undefined) {
    route = collection.dependencies.repository.routeSessionId(token);
    collection.routes.set(token, route);
  }
  return await route === scope.applicationSessionId;
}

async function plan(candidate: TurnInterjectionCandidate, collection: Collection): Promise<Plan | null> {
  const update = parseTelegramUpdate(candidate.payload);
  if (update?.kind !== "message") return null;
  const message = update.message;
  // The SQL filter already selected the sender; the parsed identity must agree with it.
  if (message.from?.id !== collection.scope.telegramUserId || message.from.isBot) return null;
  const isVoice = Object.hasOwn(message.raw, "voice");
  const text = isVoice ? message.caption : telegramInboundText(message);
  if (!isVoice && isTelegramSlashCommand(text)) return null;
  if (!addressed(message, text, collection) || !await landsInThisConversation(message, collection)) return null;

  if (isVoice) {
    const usable = candidate.voice !== null &&
      (candidate.voiceTranscript !== null || await collection.dependencies.authorizeVoice(message));
    if (!usable) {
      return {
        contentKind: "notice",
        entry: { kind: "voice_unavailable", reason: "not_transcribed", sentAt: sentAt(message) },
        updateId: candidate.updateId,
      };
    }
    if (candidate.voiceTranscript === null) {
      // Later recordings are left waiting for a later tool call instead of delaying this result.
      if (collection.transcriptions >= TURN_INTERJECTION_MAX_TRANSCRIPTIONS_PER_CALL) return null;
      collection.transcriptions += 1;
    }
    return {
      contentKind: "voice",
      sentAt: sentAt(message),
      transcript: candidate.voiceTranscript,
      updateId: candidate.updateId,
      voice: candidate.voice!,
    };
  }

  if (classifyTelegramInboundMedia(message) !== "none") {
    return {
      contentKind: "notice",
      entry: {
        attachment: attachmentKind(message),
        caption: message.caption ? bounded(message.caption).text : null,
        count: 1 + candidate.albumMemberCount,
        kind: "attachment",
        sentAt: sentAt(message),
      },
      updateId: candidate.updateId,
    };
  }
  if (!text) return null;
  return { contentKind: "text", entry: { kind: "text", sentAt: sentAt(message), ...bounded(text) }, updateId: candidate.updateId };
}

async function unavailableVoice(
  planned: Extract<Plan, { contentKind: "voice" }>,
  collection: Collection,
  reason: "not_transcribed" | "transcription_failed",
): Promise<TurnInterjectionEntry> {
  await collection.dependencies.repository.claim(collection.coordinate, [{ contentKind: "notice", updateId: planned.updateId }]);
  return { kind: "voice_unavailable", reason, sentAt: planned.sentAt };
}

async function voiceEntry(
  planned: Extract<Plan, { contentKind: "voice" }>,
  collection: Collection,
): Promise<TurnInterjectionEntry> {
  const voice = (transcript: string): TurnInterjectionEntry => {
    const { text, truncated } = bounded(transcript);
    return { kind: "voice", sentAt: planned.sentAt, transcript: text, truncated };
  };
  if (planned.transcript !== null) return voice(planned.transcript);
  const { repository } = collection.dependencies;
  const begun = await repository.beginEarlyVoiceTranscription(planned.updateId);
  if (begun.status === "transcribed") return voice(begun.transcript);
  // Started elsewhere without a transcript: that attempt was interrupted and is never paid again.
  if (begun.status === "unavailable") return await unavailableVoice(planned, collection, "transcription_failed");
  let transcript: string;
  try {
    transcript = (await collection.dependencies.transcribeVoice({
      ...planned.voice,
      ...(collection.signal ? { signal: collection.signal } : {}),
    })).trim();
    if (!transcript) {
      throw new AppError("AGENT_VOICE_TRANSCRIPT_EMPTY", "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз");
    }
  } catch (error) {
    // Recovery path: the turn learns the recording failed; the ordinary turn asks for a resend.
    console.warn(JSON.stringify({
      code: "AGENT_TURN_INTERJECTION_VOICE_UNAVAILABLE",
      error: error instanceof Error ? error.message : String(error),
      eveTurnId: collection.coordinate.eveTurnId,
      updateId: planned.updateId,
    }));
    return await unavailableVoice(planned, collection, "transcription_failed");
  }
  return voice(await repository.saveEarlyVoiceTranscript(planned.updateId, transcript) ?? transcript);
}

async function renderClaimed(plans: readonly Plan[], owned: ReadonlySet<string>, collection: Collection): Promise<string | null> {
  const entries: TurnInterjectionEntry[] = [];
  for (const planned of plans) {
    if (!owned.has(planned.updateId)) continue;
    entries.push(planned.contentKind === "voice" ? await voiceEntry(planned, collection) : planned.entry);
  }
  if (entries.length === 0) return null;
  await collection.dependencies.repository.markReturned(collection.coordinate, [...owned]);
  return formatTurnInterjectionBlock(collection.scope.marker, entries);
}

function callCoordinate(ctx: ToolContext): TurnInterjectionShowCoordinate {
  return { eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id, toolCallId: ctx.callId };
}

async function releaseClaims(
  dependencies: TurnInterjectionCollectorDependencies,
  coordinate: TurnInterjectionShowCoordinate,
): Promise<void> {
  try {
    await dependencies.repository.releaseCall(coordinate);
  } catch (error) {
    // The caller reports its own failure; a claim that stays unreleased is at worst shown again.
    console.error(JSON.stringify({
      code: "AGENT_TURN_INTERJECTION_RELEASE_FAILED",
      error: error instanceof Error ? error.message : String(error),
      eveTurnId: coordinate.eveTurnId,
    }));
  }
}

export function createTurnInterjectionCollector(
  dependencies: TurnInterjectionCollectorDependencies,
): TurnInterjection {
  async function release(ctx: ToolContext): Promise<void> {
    if (resolveTurnInterjectionScope(ctx) === null) return;
    await releaseClaims(dependencies, callCoordinate(ctx));
  }

  async function collect(ctx: ToolContext): Promise<string | null> {
    const scope = resolveTurnInterjectionScope(ctx);
    if (!scope) return null;
    const collection: Collection = {
      coordinate: { ...callCoordinate(ctx), applicationSessionId: scope.applicationSessionId },
      dependencies,
      routes: new Map(),
      scope,
      signal: ctx.abortSignal,
      transcriptions: 0,
    };
    // A retry of this call starts from scratch, so an earlier attempt's returned claims cannot be
    // counted as seen when this attempt ends up returning none.
    await dependencies.repository.releaseCall(collection.coordinate);
    const candidates = await dependencies.repository.listCandidates({
      ...collection.coordinate,
      currentUpdateId: scope.currentUpdateId,
      limit: TURN_INTERJECTION_CANDIDATE_LIMIT,
      telegramUserId: scope.telegramUserId,
    });
    const plans: Plan[] = [];
    for (const candidate of candidates) {
      if (plans.length >= TURN_INTERJECTION_MAX_MESSAGES) break;
      const planned = await plan(candidate, collection);
      if (planned) plans.push(planned);
    }
    if (plans.length === 0) return null;

    const owned = await dependencies.repository.claim(
      collection.coordinate,
      plans.map((planned): { contentKind: TurnInterjectionContentKind; updateId: string } => ({
        contentKind: planned.contentKind,
        updateId: planned.updateId,
      })),
    );
    if (owned.size === 0) return null;
    try {
      return await renderClaimed(plans, owned, collection);
    } catch (error) {
      await releaseClaims(dependencies, collection.coordinate);
      throw error;
    }
  }

  return { collect, release };
}
