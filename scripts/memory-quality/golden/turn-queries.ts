/**
 * The questions memory was asked on real turns, rebuilt from the turn journal of a database copy.
 *
 * Exports:
 * - `GoldenQuery` / `SkippedTurn`: a turn's question with the areas it could read, or why none.
 * - `goldenQueryFromTurn`: one stored turn to its question; pure.
 * - `loadTurnQuestions`: every conversation turn of the copy, newest first.
 *
 * The question is rebuilt by the product's own functions — the turn's messages assembled as the
 * runtime assembles them, the search text picked and cleaned as the memory block picks it, the
 * rights read from the turn's verified attributes as the memory tools read them. A copy of that
 * logic here would measure the copy.
 */
import type { UserContent } from "ai";

import { isAppError } from "../../../agent/lib/app-error.js";
import { database } from "../../../agent/lib/database.js";
import { requireMemoryAuthorization, type MemoryAuthorization } from "../../../agent/lib/memory-context.js";
import { prepareMemoryQuery } from "../../../agent/lib/memory-query-preparation.js";
import { memoryRetrievalQuery } from "../../../agent/lib/memory-retrieval.js";
import type { SessionAuth } from "../../../agent/runtime/context.js";
import { instructionTurnMessages } from "../../../agent/runtime/prompt/turn-instructions.js";

export interface GoldenQuery {
  authorization: MemoryAuthorization;
  kind: "question";
  /** The person's message before cleaning, for whoever judges relevance. */
  message: string;
  /** The text the search ran on. */
  query: string;
  sessionId: string;
  startedAt: string;
  turnId: string;
}

export interface SkippedTurn {
  kind: "skipped";
  /**
   * `no_message` for a turn without a message of its own, `no_query` for one that never searched
   * memory, otherwise the authorization failure code.
   */
  reason: string;
  turnId: string;
}

export interface StoredTurnRow {
  auth: unknown;
  created_at: Date;
  id: string;
  input: { context: string[]; message?: UserContent };
  session_id: string;
}

export function goldenQueryFromTurn(row: StoredTurnRow): GoldenQuery | SkippedTurn {
  const auth = row.auth as SessionAuth;
  // What the memory resolver saw, minus the history: with a message of its own the search reads
  // only this turn's input. Without one it read the last message of the history, which the turn
  // journal does not hold, so there is no question to rebuild.
  const messages = instructionTurnMessages([], { context: row.input.context, message: row.input.message });
  if (messages.length === 0) return { kind: "skipped", reason: "no_message", turnId: row.id };
  let raw: string | null;
  let authorization: MemoryAuthorization;
  try {
    raw = memoryRetrievalQuery(auth, messages, false);
    if (raw === null) return { kind: "skipped", reason: "no_query", turnId: row.id };
    authorization = requireMemoryAuthorization({ session: { auth } } as Parameters<typeof requireMemoryAuthorization>[0]);
  } catch (error) {
    // The turn itself could not read memory either — an envelope it could not parse, rights it
    // did not have — so its block said so and searched nothing; neither does the measurement.
    if (isAppError(error)) return { kind: "skipped", reason: error.code, turnId: row.id };
    throw error;
  }
  return {
    authorization,
    kind: "question",
    // For a group turn this is the addressed message the search took out of the envelope.
    message: raw,
    query: prepareMemoryQuery(raw),
    sessionId: row.session_id,
    startedAt: row.created_at.toISOString(),
    turnId: row.id,
  };
}

/**
 * Conversation turns only: a memory review, a scheduled run or a delegated child is not a person
 * asking. Failed turns stay in: their memory block was built before they failed.
 */
export async function loadTurnQuestions(): Promise<(GoldenQuery | SkippedTurn)[]> {
  const turns = await database().query<StoredTurnRow>(
    `SELECT id, session_id, created_at, auth, input
     FROM agent_turns
     WHERE kind = 'conversation' AND status IN ('completed', 'failed')
     ORDER BY created_at DESC, id DESC`,
  );
  return turns.rows.map(goldenQueryFromTurn);
}
