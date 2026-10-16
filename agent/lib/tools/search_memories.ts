/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { recordToolShows } from "../memory-tool-shows.js";
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { currentTimeRepository } from "../current-time-repository.js";
import {
  memoryEventWindowRepository,
  MEMORY_EVENT_WINDOW_LIMIT,
} from "../memory-event-window-repository.js";
import {
  retrieveRelevantMemories,
  type MemoryRetrievalDiagnostics,
} from "../memory-retrieval.js";
import {
  memorySelectionMetrics,
  offeredMemoryEvidence,
  type OfferedMemoryEvidence,
} from "../memory-observability.js";
import { toModelMemory, type ModelMemory } from "../model-memory.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
// Open ends of a period, not defaults for missing data: the column itself is bounded to this range.
const EARLIEST_SEARCHABLE_DAY = "1900-01-01";
const LATEST_SEARCHABLE_DAY = "2100-01-01";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "Search by words and meaning for saved facts about the participants, their experience, earlier discussions, decisions and recommendations in the available memory scopes. This is not an internet search; do not use it for external facts and ready-made material unrelated to the history of the user or the chat.",
    "If the automatic selection is not enough for such a question, call the tool up to three times with different meaningful wordings and stop when the context is sufficient or new relevant facts are no longer found.",
    "For a request to recall the past or give that link, first reconstruct the subject by an explicit name or description from the visible conversation; an empty automatic selection does not prove there is no record.",
    "For a question about a period (what happened in August, what was agreed last week) set from and to: then selection goes by the event date, and for records without one by the date they appeared. In this mode query does not take part in the selection.",
    `A period returns no more than ${MEMORY_EVENT_WINDOW_LIMIT} records, the latest by event date. If there are exactly that many, the period may not have fit entirely: narrow it and repeat.`,
    "Usually the result is an array of records. If an object with an incompleteSelection field came instead, the selection was assembled by words only and is incomplete: tell the person so rather than concluding that the fact is absent.",
  ].join(" "),
  inputSchema: z.object({
    from: DAY.optional().describe("The start of the period, YYYY-MM-DD: selects records by event date"),
    query: z.string().min(1).max(2_000),
    to: DAY.optional().describe("The end of the period, YYYY-MM-DD, inclusive"),
  }),
  async execute({ from, query, to }, ctx) {
    const started = performance.now();
    let found: ModelMemory[] | null = null;
    let diagnostics: MemoryRetrievalDiagnostics | null = null;
    // Null for a period: those records are picked by date, so there is no rank to describe.
    let memoryEvidence: OfferedMemoryEvidence[] | null = null;
    const auth = requireMemoryAuthorization(ctx);
    try {
      // A period is a different question from a phrase, and it is answered by the dates alone:
      // the words of the query would only re-rank what the period already selected.
      if (from !== undefined || to !== undefined) {
        const window = await memoryEventWindowRepository.search(auth, {
          from: from ?? EARLIEST_SEARCHABLE_DAY,
          // A record without an event date falls back to the day it appeared, and which day that
          // was depends on where the person lives, not on where the database runs.
          timezone: auth.userId === null
            ? null
            : await currentTimeRepository.findUserTimezone(auth.userId, auth.familyId),
          to: to ?? LATEST_SEARCHABLE_DAY,
        });
        found = window.map((item) => toModelMemory(item));
        await recordToolShows(ctx, found.map((item) => item.memoryRef), "search");
        return found;
      }
      const result = await retrieveRelevantMemories(auth, query);
      found = result.memories;
      diagnostics = result.diagnostics;
      await recordToolShows(ctx, found.map((item) => item.memoryRef), "search");
      memoryEvidence = offeredMemoryEvidence(result.memories, result.rankingByMemoryRef);
      // Without the semantic branch a paraphrase simply does not match, and an empty result read
      // as «этого нет» is worse than no answer at all.
      if (!result.diagnostics.semanticBranchAvailable) {
        return {
          incompleteSelection: "Смысловая ветка поиска сейчас недоступна: найдено только по точным словам, перефразированный вопрос мог не найтись. Не делай вывода, что сведения нет.",
          items: found,
        };
      }
      return found;
    } finally {
      console.info(JSON.stringify({ code: "AGENT_MEMORY_SEARCH_METRICS",
        sessionId: ctx.session.id, turnId: ctx.session.turn.id, callId: ctx.callId,
        outcome: found === null ? "failed" : "succeeded",
        window: from === undefined && to === undefined ? null : { from: from ?? null, to: to ?? null },
        ...memorySelectionMetrics(found),
        memoryEvidence,
        ...diagnostics,
        durationMs: Math.round(performance.now() - started),
      }));
    }
  },
});
