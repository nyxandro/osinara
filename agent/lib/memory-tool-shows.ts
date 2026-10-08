/**
 * Writing down the records a memory tool put in front of the model.
 *
 * Export:
 * - `recordToolShows`: journals what `search_memories` or `list_memories` returned to this turn.
 *
 * The model names records it used, and the usage counter accepts only records the journal says it
 * was shown (#339). A record found by a deliberate search used to be refused there, and the
 * forgetting curve then aged exactly what the automatic selection had missed.
 *
 * Bookkeeping must never cost the person the search, as with the usage line itself: a failed write
 * is logged once with its cause and the tool returns what it found.
 */
import type { SessionContext } from "../runtime/context.js";

import { memoryFailureCode } from "./memory-context-failure.js";
import { memoryShowJournal } from "./memory-show-journal.js";

export async function recordToolShows(
  ctx: SessionContext,
  memoryRefs: readonly string[],
  source: "list" | "search",
): Promise<void> {
  const conversationId = ctx.session.auth.current?.attributes.telegramConversationId;
  // No conversation, no journal: a scheduled run outside a chat counts nothing, as before.
  if (typeof conversationId !== "string" || memoryRefs.length === 0) return;
  try {
    await memoryShowJournal.recordShownRefs(
      { agentSessionId: ctx.session.id, conversationId, turnId: ctx.session.turn.id }, memoryRefs, source,
    );
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_SHOW_RECORD_FAILED",
      causeCode: memoryFailureCode(error) ?? "UNCLASSIFIED_SHOW_JOURNAL_ERROR",
      sessionId: ctx.session.id, source, turnId: ctx.session.turn.id,
    }));
  }
}
