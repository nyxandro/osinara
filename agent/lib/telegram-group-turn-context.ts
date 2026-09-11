/**
 * Durable model input for one Telegram group turn.
 *
 * Exports:
 * - `TelegramGroupTurnContextPreparer`: injectable bootstrap/incremental context contract.
 * - `composeTelegramTurnMessage`: joins a controlled timeline and exact current envelope.
 * - `createTelegramGroupTurnContextPreparer`: composes timeline and session cursor repositories.
 * - `telegramGroupTurnContextPreparer`: production context preparer.
 * - `currentTelegramMessageText`: reads the addressed message back out of the durable envelope.
 */
import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../config.js";
import { AppError } from "./app-error.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { escapeUntrustedContextJson } from "./untrusted-context-json.js";
import { groupTimelineCursorRepository } from "./sessions/group-timeline-cursor-repository.js";
import {
  type TelegramAttachmentReferenceAccess,
  visibleTelegramTimelineEntry,
} from "./telegram-attachment-reference-access.js";
import {
  selectTelegramGroupJournalContext,
  type TelegramGroupJournalEntry,
  type TelegramTimelineOmission,
} from "./telegram-group-journal-context.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";
import type { TelegramReplyTargetSnapshot } from "./telegram-reply-target-snapshot.js";

interface PrepareTelegramGroupTurnContextInput {
  applicationSessionId: string;
  attachmentReferenceAccess: TelegramAttachmentReferenceAccess;
  currentEntryId: string;
  currentSenderDisplayName: string;
  currentSenderUsername: string | null;
  currentSequence: string;
  conversationId?: string;
  groupId: string | null;
  messageText: string;
  messageThreadId: string | null;
  replyTargetSnapshot?: TelegramReplyTargetSnapshot | null;
  replyTargetUnavailable: boolean;
  replyToSequenceId: string | null;
}

interface TelegramGroupTurnContextDependencies {
  journal: Pick<TelegramGroupJournalRepository, "listIncremental" | "listRecent">;
  timeline?: Pick<typeof conversationTimelineRepository, "listIncremental" | "listRecent">;
  sessions: Pick<typeof groupTimelineCursorRepository, "currentGroupTimelineCursor">;
}

export interface PreparedTelegramGroupTurnContext {
  cursorSequence: string;
  durableMessage: string;
  omittedBeforeSequence: string | null;
  visibleEntryIds: string[];
  visibleTimelineEntries: TelegramGroupJournalEntry[];
  currentMessageEnvelope: string;
  timelineOmission: TelegramTimelineOmission | null;
  memoryReviewBatchId?: string;
  memoryReviewSourceEntryIds?: string[];
}

export type TelegramGroupTurnContextPreparer = (
  input: PrepareTelegramGroupTurnContextInput,
) => Promise<PreparedTelegramGroupTurnContext>;

const CURRENT_MESSAGE_OPEN_TAG = "<current_telegram_message>";
const CURRENT_MESSAGE_CLOSE_TAG = "</current_telegram_message>";
const TURN_MESSAGE_ERROR_CODE = "AGENT_TELEGRAM_TURN_MESSAGE_INVALID";
const CURRENT_TIMELINE_ENTRY_COUNT = 1;

function turnMessageError(reason: string, detail?: string): AppError {
  // The exact failure stays in logs; the caller only needs the stable contract error.
  console.error(JSON.stringify({
    code: TURN_MESSAGE_ERROR_CODE,
    reason,
    ...(detail === undefined ? {} : { detail }),
  }));
  return new AppError(
    TURN_MESSAGE_ERROR_CODE,
    "Не удалось прочитать текущее сообщение группы. Отправьте сообщение ещё раз",
  );
}

function currentTelegramMessageEnvelope(
  input: Pick<
    PrepareTelegramGroupTurnContextInput,
    | "currentSenderDisplayName"
    | "currentSenderUsername"
    | "currentSequence"
    | "messageText"
    | "replyTargetSnapshot"
    | "replyTargetUnavailable"
    | "replyToSequenceId"
  >,
  inlineReply?: TelegramGroupJournalEntry,
): string {
  const snapshotConflict = input.replyTargetSnapshot !== null &&
    input.replyTargetSnapshot !== undefined &&
    (!input.replyTargetUnavailable || input.replyToSequenceId !== null);
  if ((input.replyTargetUnavailable && input.replyToSequenceId !== null) || snapshotConflict) {
    throw turnMessageError("reply_metadata_conflict");
  }
  if (inlineReply && inlineReply.sequenceId !== input.replyToSequenceId) {
    throw turnMessageError("inline_reply_identity_conflict");
  }
  // The exact envelope is retained as trusted composition metadata without Telegram identifiers.
  const currentMessage = escapeUntrustedContextJson({
    sourceSequence: input.currentSequence,
    senderDisplayName: input.currentSenderDisplayName,
    senderUsername: input.currentSenderUsername,
    ...(input.replyTargetSnapshot
      ? { replyTargetSnapshot: input.replyTargetSnapshot }
      : input.replyTargetUnavailable
        ? { replyTargetUnavailable: true }
        : {}),
    ...(input.replyToSequenceId === null ? {} : { replyToSequenceId: input.replyToSequenceId }),
    ...(inlineReply ? { replyTo: {
      senderKind: inlineReply.actorKind,
      senderDisplayName: inlineReply.senderDisplayName,
      text: inlineReply.contentText,
    } } : {}),
    text: input.messageText,
  });
  return `${CURRENT_MESSAGE_OPEN_TAG}\n${currentMessage}\n${CURRENT_MESSAGE_CLOSE_TAG}`;
}

export function composeTelegramTurnMessage(
  timeline: string | null,
  currentMessageEnvelope: string,
): string {
  return timeline === null ? currentMessageEnvelope : `${timeline}\n\n${currentMessageEnvelope}`;
}

/**
 * Reads the addressed message text back out of an envelope this module produced. Participant text
 * inside the envelope has its markup escaped, so the delimiters are unambiguous and a malformed
 * payload means the durable turn input is corrupt rather than merely unusual.
 */
export function currentTelegramMessageText(durableMessage: string): string {
  const opening = durableMessage.lastIndexOf(CURRENT_MESSAGE_OPEN_TAG);
  const closing = durableMessage.lastIndexOf(CURRENT_MESSAGE_CLOSE_TAG);
  if (opening < 0 || closing <= opening) throw turnMessageError("envelope_missing");

  const payload = durableMessage.slice(opening + CURRENT_MESSAGE_OPEN_TAG.length, closing).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw turnMessageError(
      "envelope_unparsable",
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = (parsed as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw turnMessageError("text_missing");
  return text;
}

export function createTelegramGroupTurnContextPreparer(
  dependencies: TelegramGroupTurnContextDependencies,
): TelegramGroupTurnContextPreparer {
  return async (input) => {
    const cursor = await dependencies.sessions.currentGroupTimelineCursor(
      input.applicationSessionId,
    );
    const useConversationTimeline = input.conversationId !== undefined;
    if (useConversationTimeline && !dependencies.timeline) {
      throw new AppError(
        "AGENT_CONVERSATION_TIMELINE_REPOSITORY_MISSING",
        "Не удалось загрузить историю личного разговора",
      );
    }
    const page = cursor === null
      ? {
          entries: useConversationTimeline
            ? await dependencies.timeline!.listRecent({
                beforeSequence: input.currentSequence,
                conversationId: input.conversationId!,
                limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
              })
            : await dependencies.journal.listRecent({
            anchorEntryId: input.currentEntryId,
            beforeSequence: input.currentSequence,
            groupId: input.groupId!,
            limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
            messageThreadId: input.messageThreadId,
          }),
          omittedBeforeSequence: null,
        }
      : useConversationTimeline
        ? await dependencies.timeline!.listIncremental({
            afterSequence: cursor,
            applicationSessionId: input.applicationSessionId,
            beforeSequence: input.currentSequence,
            conversationId: input.conversationId!,
            limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
          })
        : await dependencies.journal.listIncremental({
            afterSequence: cursor,
            anchorEntryId: input.currentEntryId,
            applicationSessionId: input.applicationSessionId,
            beforeSequence: input.currentSequence,
            groupId: input.groupId!,
            limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
            messageThreadId: input.messageThreadId,
          });
    // Current capabilities filter each historical reference by its exact admitted media class.
    const visibleEntries = page.entries.map((entry) =>
      visibleTelegramTimelineEntry(entry, input.attachmentReferenceAccess)
    );
    const currentMessageEnvelope = currentTelegramMessageEnvelope(input);
    const currentMessageCharacters = currentMessageEnvelope.length;
    const timelineCharacterBudget = TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS -
      currentMessageCharacters - 2;
    if (timelineCharacterBudget <= 0) {
      throw new AppError(
        "AGENT_TELEGRAM_TURN_CONTEXT_TOO_LARGE",
        "Текущее сообщение превышает допустимый размер контекста разговора",
      );
    }
    let selected = selectTelegramGroupJournalContext(
      visibleEntries,
      timelineCharacterBudget,
      page.omittedBeforeSequence,
      input.replyToSequenceId,
      TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
    );
    let inlineReply: TelegramGroupJournalEntry | undefined;
    const replyEntry = input.groupId === null ? undefined : selected.entries.find(
      (entry) => entry.sequenceId === input.replyToSequenceId,
    );
    if (replyEntry) {
      const inlineEnvelope = currentTelegramMessageEnvelope(input, replyEntry);
      const inlineBudget = TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS - inlineEnvelope.length - 2;
      if (inlineBudget > 0) {
        const withInlineReply = selectTelegramGroupJournalContext(
          visibleEntries, inlineBudget, page.omittedBeforeSequence, input.replyToSequenceId,
          TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES - CURRENT_TIMELINE_ENTRY_COUNT,
        );
        // The inline copy is presentation only. Never lose an otherwise readable long reply or
        // silently shorten its text to fit it twice; the existing timeline/id contract still works.
        if (withInlineReply.entries.some((entry) => entry.sequenceId === replyEntry.sequenceId)) {
          selected = withInlineReply;
          inlineReply = replyEntry;
        }
      }
    }
    const timeline = selected.context;
    // A DB-resolved reply is usable only when its protected target survived model-context bounds.
    const replyTargetIncluded = input.replyToSequenceId === null ||
      timeline?.includes(`\n#${input.replyToSequenceId} [`) === true;
    const replyToSequenceId = replyTargetIncluded ? input.replyToSequenceId : null;
    const replyTargetUnavailable = input.replyTargetUnavailable || !replyTargetIncluded;
    const resolvedCurrentMessageEnvelope = currentTelegramMessageEnvelope({
      ...input,
      replyTargetUnavailable,
      replyToSequenceId,
    }, inlineReply);
    const durableMessage = composeTelegramTurnMessage(timeline, resolvedCurrentMessageEnvelope);
    if (durableMessage.length > TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS) {
      throw new AppError(
        "AGENT_TELEGRAM_TURN_CONTEXT_TOO_LARGE",
        "История разговора превышает допустимый размер контекста",
      );
    }
    return {
      cursorSequence: input.currentSequence,
      durableMessage,
      currentMessageEnvelope: resolvedCurrentMessageEnvelope,
      omittedBeforeSequence: page.omittedBeforeSequence,
      timelineOmission: selected.omission,
      visibleEntryIds: [
        ...selected.entries.flatMap((entry) => entry.entryId ? [entry.entryId] : []),
        input.currentEntryId,
      ],
      visibleTimelineEntries: selected.entries,
    };
  };
}

export const telegramGroupTurnContextPreparer = createTelegramGroupTurnContextPreparer({
  journal: telegramGroupJournalRepository,
  sessions: groupTimelineCursorRepository,
  timeline: conversationTimelineRepository,
});
