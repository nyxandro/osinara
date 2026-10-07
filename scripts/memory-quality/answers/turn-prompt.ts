/**
 * One stored turn rebuilt as the model request the runtime made, minus what the comparison varies.
 *
 * Exports:
 * - `HISTORY_TAIL_MAX_CHARACTERS` / `historyTail`: the end of the conversation before the turn,
 *   cut at a person's message so no tool result arrives without its call.
 * - `StoredTurn` / `loadStoredTurn`: the turn's verified rights, input and session from the journal.
 * - `loadHistoryBefore`: the session's history as it stood when the turn began.
 * - `turnMessages`: that history followed by the turn's own input, as the runtime appends it.
 * - `turnModeBlock`: the mode rules of the turn, resolved once and shared by every condition.
 * - `turnSystemPrompt`: the agent's base prompt, the mode rules and an optional memory block,
 *   composed by the runtime's own function. The memory block keeps its payload markers, so the
 *   transport lifts it into the turn tail exactly as in production.
 *
 * Left out, the same for every condition: the delegation, presentation-preference and reaction-set
 * blocks, the profile view beside the records, skills, and every tool but `search_memories` —
 * which is offered even in an external group whose grants would not include it, with its own
 * description rather than the group's wrapper. A turn that asked for a tool the harness does not
 * offer can be answered with the mode's refusal; that happens the same way under each condition.
 *
 * The history is cut to its tail, measured with tool outputs and reasoning included: one long reply
 * can leave a turn with no history at all. The whole history of a long chat would multiply the cost
 * of every request and change nothing between the conditions compared. A group turn carries the
 * recent timeline in its own input either way.
 *
 * Production's own instruction blocks are stored with each turn (`agent_turns.prepared`); reading
 * them instead would remove most of these omissions, at the price of taking the memory block out
 * of them. Not done yet.
 */
import type { ModelMessage, UserContent } from "ai";

import { createOsinaraAgent } from "../../../agent/agent.js";
import { AppError } from "../../../agent/lib/app-error.js";
import { database } from "../../../agent/lib/database.js";
import { resolveModeBlock } from "../../../agent/lib/prompt/turn-blocks.js";
import type { SessionAuth } from "../../../agent/runtime/context.js";
import { composeSystemPrompt } from "../../../agent/runtime/prompt/system-prompt.js";
import { turnInputMessages } from "../../../agent/runtime/prompt/turn-instructions.js";

/** About the last exchange or two of a private chat; a group turn carries its timeline in the input. */
export const HISTORY_TAIL_MAX_CHARACTERS = 12_000;

const BASE_PROMPT = createOsinaraAgent().basePrompt;

export interface StoredTurn {
  auth: SessionAuth;
  input: { context: string[]; message?: UserContent };
  sessionId: string;
  startedAt: Date;
  turnId: string;
}

export async function loadStoredTurn(turnId: string): Promise<StoredTurn> {
  const row = (await database().query<{
    auth: SessionAuth; created_at: Date; input: StoredTurn["input"]; session_id: string;
  }>("SELECT auth, input, session_id, created_at FROM agent_turns WHERE id = $1", [turnId])).rows[0];
  if (row === undefined) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_TURN_MISSING",
      `Хода ${turnId} из эталона нет в копии базы. Восстановите ту же резервную копию, по которой собран эталон`,
    );
  }
  return { auth: row.auth, input: row.input, sessionId: row.session_id, startedAt: row.created_at, turnId };
}

export function historyTail(messages: readonly ModelMessage[], maxCharacters: number): ModelMessage[] {
  let characters = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    characters += JSON.stringify(messages[index]).length;
    if (characters > maxCharacters) break;
    if (messages[index]!.role === "user") start = index;
  }
  return messages.slice(start);
}

/**
 * The generation active when the turn began is the newest one that already had messages then: a
 * compaction after the turn writes a later generation, every row of it newer than the turn.
 */
export async function loadHistoryBefore(turn: StoredTurn): Promise<ModelMessage[]> {
  const rows = await database().query<{ message: ModelMessage }>(
    `WITH active AS (
       SELECT max(generation) AS generation FROM agent_session_history
       WHERE session_id = $1 AND created_at < $2
     )
     SELECT history.message
     FROM agent_session_history AS history
     JOIN active ON history.generation = active.generation
     WHERE history.session_id = $1 AND history.created_at < $2
     ORDER BY history.position`,
    [turn.sessionId, turn.startedAt],
  );
  return rows.rows.map((row) => row.message);
}

export function turnMessages(turn: StoredTurn, history: readonly ModelMessage[]): ModelMessage[] {
  return [
    ...history,
    ...turnInputMessages({ context: turn.input.context, message: turn.input.message, userInstructions: [] }),
  ];
}

export async function turnModeBlock(turn: StoredTurn, messages: readonly ModelMessage[]): Promise<string> {
  return await resolveModeBlock({ messages, session: { auth: turn.auth, id: turn.sessionId } });
}

export function turnSystemPrompt(modeBlock: string, memoryBlock: string | null): string {
  return composeSystemPrompt({
    base: BASE_PROMPT,
    instructionBlocks: [modeBlock, ...(memoryBlock === null ? [] : [memoryBlock])],
    skillsSection: null,
  });
}
