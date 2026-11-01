/**
 * What a message that points elsewhere borrows for the memory search of its turn.
 *
 * Exports:
 * - `MemoryQueryContextSource`, `memoryQueryContextRepository`: the conversation's journal, read for
 *   the message a reply answers and for the messages just before one.
 * - `memoryQueryConversationContext`: the text a referring message borrows, with where it came from.
 * - `memoryTurnQueryContext`: the same for a turn, from its verified conversation and message envelope.
 *
 * Key constructs:
 * - Production, 01.11.2026: «Кинь ссылку на эти скилы» named nothing, and the search by it brought
 *   eight unrelated records; the message it answered named the skill.
 * - Only a short message that refers elsewhere borrows: a reply, or a word like «эти», «его», «там»,
 *   in a few words. A longer message carries its own words, and borrowing on every «это» would cost
 *   a second search on most turns. A reply borrows its target alone: in a busy group the messages
 *   just before are usually another thread, as they were that morning; without a reply the messages
 *   just before come from the same topic.
 * - A failed read of the journal costs the turn only the borrowed words, never its memory.
 * - The borrowed text is searched with and never gates: small talk and a named date stay decided by
 *   the person's own words (`memory-automatic-selection.ts`).
 */
import type { ModelMessage } from "ai";

import type { SessionAuth } from "../runtime/context.js";
import { database } from "./database.js";
import { prepareMemoryQuery } from "./memory-query-preparation.js";
import { latestUserText } from "./memory-retrieval.js";
import { isSmallTalkMessage } from "./memory-small-talk.js";
import { isTelegramMediaPlaceholderOnly } from "./telegram-content/telegram-content-description.js";
import { currentTelegramMessageReply } from "./telegram-group-turn-context.js";
import { CAPTIONLESS_ATTACHMENT_MODEL_TEXT } from "./telegram-model-placeholders.js";

const SHORT_MESSAGE_WORDS = 8;
const PREVIOUS_MESSAGES = 3;
const BORROWED_LINE_MAX_CHARACTERS = 400;
// Pronouns and demonstratives that point at something said elsewhere.
const REFERRING_WORD_PATTERN =
  /(?<![\p{L}\p{N}])(?:эт(?:от|а|о|и|ого|ой|им|их|ому|у|ими)|т(?:от|а|е|ого|ой|ем|ех|ому|у|еми)|так(?:ой|ая|ое|ие|их|ую|им)|он[аои]?|е(?:го|ё)|ее|их|н(?:его|её|ее|их|им|ей|ему|ими|ём|ем)|там|туда|оттуда|тогда)(?![\p{L}\p{N}])/iu;

export interface MemoryQueryContextSource {
  previous(input: { before: string; conversationId: string; limit: number }): Promise<string[]>;
  replyTarget(input: { conversationId: string; sequenceId: string }): Promise<string | null>;
}

export const memoryQueryContextRepository: MemoryQueryContextSource = {
  async previous(input) {
    // Only the current message's own topic: a forum group keeps several conversations at once.
    const result = await database().query<{ content_text: string }>(
      `SELECT message.content_text FROM telegram_group_messages AS message
       WHERE message.conversation_id = $1 AND message.sequence_id < $2 AND message.content_text IS NOT NULL
         AND message.message_thread_id IS NOT DISTINCT FROM (
           SELECT current.message_thread_id FROM telegram_group_messages AS current
           WHERE current.conversation_id = $1 AND current.sequence_id = $2
         )
       ORDER BY message.sequence_id DESC LIMIT $3`,
      [input.conversationId, input.before, input.limit],
    );
    return result.rows.map((row) => row.content_text);
  },
  async replyTarget(input) {
    const result = await database().query<{ content_text: string | null }>(
      "SELECT content_text FROM telegram_group_messages WHERE conversation_id = $1 AND sequence_id = $2",
      [input.conversationId, input.sequenceId],
    );
    return result.rows[0]?.content_text ?? null;
  },
};

function refersElsewhere(text: string, replies: boolean): boolean {
  const words = text.split(/\s+/u).filter(Boolean);
  return words.length <= SHORT_MESSAGE_WORDS && (replies || REFERRING_WORD_PATTERN.test(text));
}

// The same words the selection itself stays silent on (`memory-automatic-selection.ts`).
function asksMemoryNothing(text: string): boolean {
  const prepared = prepareMemoryQuery(text);
  return isSmallTalkMessage(prepared) || prepared === CAPTIONLESS_ATTACHMENT_MODEL_TEXT || isTelegramMediaPlaceholderOnly(prepared);
}

function bounded(text: string): string {
  const folded = text.replace(/\s+/gu, " ").trim();
  return folded.length > BORROWED_LINE_MAX_CHARACTERS ? folded.slice(0, BORROWED_LINE_MAX_CHARACTERS) : folded;
}

export async function memoryQueryConversationContext(
  source: MemoryQueryContextSource,
  input: {
    conversationId: string | null;
    /** The message replies to a target the journal no longer holds. */
    replyTargetUnavailable?: boolean;
    /** The replied text the turn's envelope already carries: a quoted fragment or the target itself. */
    replyText: string | null;
    replyToSequenceId: string | null;
    sourceSequence: string | null;
    text: string;
  },
): Promise<{ kind: "previous" | "reply"; text: string } | null> {
  const replies = input.replyText !== null || input.replyToSequenceId !== null || input.replyTargetUnavailable === true;
  if (input.conversationId === null || asksMemoryNothing(input.text) || !refersElsewhere(input.text, replies)) return null;
  if (replies) {
    // A reply to a target no longer at hand borrows nothing: the messages just before are another thread.
    if (input.replyText === null && input.replyToSequenceId === null) return null;
    const replied = input.replyText ??
      await source.replyTarget({ conversationId: input.conversationId, sequenceId: input.replyToSequenceId! });
    const text = replied === null ? "" : bounded(replied);
    return text ? { kind: "reply", text } : null;
  }
  if (input.sourceSequence === null) return null;
  const previous = await source.previous({
    before: input.sourceSequence, conversationId: input.conversationId, limit: PREVIOUS_MESSAGES,
  });
  const text = previous.map(bounded).filter(Boolean).reverse().join("\n");
  return text ? { kind: "previous", text } : null;
}

/**
 * For a Telegram turn of a conversation: the envelope names what the message answers, and the
 * verified auth names the conversation whose journal holds it. Any other turn borrows nothing.
 */
export async function memoryTurnQueryContext(
  source: MemoryQueryContextSource,
  auth: SessionAuth,
  messages: readonly ModelMessage[],
  query: string,
): Promise<{ kind: "previous" | "reply"; text: string } | null> {
  const attributes = auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const envelope = latestUserText(messages);
  if (typeof conversationId !== "string" || typeof attributes?.telegramTimelineSequence !== "string" || envelope === null) {
    return null;
  }
  try {
    return await memoryQueryConversationContext(source, {
      conversationId,
      ...currentTelegramMessageReply(envelope),
      text: query,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_QUERY_CONTEXT_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
