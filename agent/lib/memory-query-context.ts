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
 * - Only a message that refers elsewhere borrows: a word like «эти», «его», «там», or a few words in
 *   all. A reply borrows its target alone: in a busy group the messages just before are usually
 *   another thread, as they were that morning.
 * - The borrowed text is searched with and never gates: small talk and a named date stay decided by
 *   the person's own words (`memory-automatic-selection.ts`).
 */
import type { ModelMessage } from "ai";

import type { SessionAuth } from "../runtime/context.js";
import { database } from "./database.js";
import { latestUserText } from "./memory-retrieval.js";
import { isSmallTalkMessage } from "./memory-small-talk.js";
import { currentTelegramMessageReply } from "./telegram-group-turn-context.js";

const SHORT_MESSAGE_WORDS = 6;
const PREVIOUS_MESSAGES = 3;
const BORROWED_LINE_MAX_CHARACTERS = 400;
// Pronouns and demonstratives that point at something said elsewhere.
const REFERRING_WORD_PATTERN =
  /(?<![\p{L}\p{N}])(?:эт(?:от|а|о|и|ого|ой|им|их|ому|у|ими)|т(?:от|а|е|ого|ой|ем|ех|ому|у|еми)|так(?:ой|ая|ое|ие|их|ую|им)|он[аои]?|е(?:го|ё)|ее|их|н(?:его|её|ее|их|им|ей|ему|ими|ём|ем)|там|туда|оттуда|тогда|it|this|that|these|those|them)(?![\p{L}\p{N}])/iu;

export interface MemoryQueryContextSource {
  previous(input: { before: string; conversationId: string; limit: number }): Promise<string[]>;
  replyTarget(input: { conversationId: string; sequenceId: string }): Promise<string | null>;
}

export const memoryQueryContextRepository: MemoryQueryContextSource = {
  async previous(input) {
    const result = await database().query<{ content_text: string }>(
      `SELECT content_text FROM telegram_group_messages
       WHERE conversation_id = $1 AND sequence_id < $2 AND content_text IS NOT NULL
       ORDER BY sequence_id DESC LIMIT $3`,
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

function refersElsewhere(text: string): boolean {
  const words = text.split(/\s+/u).filter(Boolean);
  return words.length <= SHORT_MESSAGE_WORDS || REFERRING_WORD_PATTERN.test(text);
}

function bounded(text: string): string {
  const folded = text.replace(/\s+/gu, " ").trim();
  return folded.length > BORROWED_LINE_MAX_CHARACTERS ? folded.slice(0, BORROWED_LINE_MAX_CHARACTERS) : folded;
}

export async function memoryQueryConversationContext(
  source: MemoryQueryContextSource,
  input: {
    conversationId: string | null;
    /** The replied text the turn's envelope already carries: a quoted fragment or the target itself. */
    replyText: string | null;
    replyToSequenceId: string | null;
    sourceSequence: string | null;
    text: string;
  },
): Promise<{ kind: "previous" | "reply"; text: string } | null> {
  if (input.conversationId === null || isSmallTalkMessage(input.text) || !refersElsewhere(input.text)) return null;
  if (input.replyText !== null || input.replyToSequenceId !== null) {
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
  return await memoryQueryConversationContext(source, {
    conversationId,
    ...currentTelegramMessageReply(envelope),
    text: query,
  });
}
