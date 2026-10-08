/**
 * One stored turn rebuilt as the model request the runtime made, minus what the comparison varies.
 *
 * Exports:
 * - `HISTORY_TAIL_MAX_CHARACTERS` / `historyTail`: the end of the conversation before the turn,
 *   cut at a person's message so no tool result arrives without its call.
 * - `StoredTurn` / `loadStoredTurn`: the turn's verified rights, channel, input, session and the
 *   instructions production prepared for it.
 * - `loadHistoryBefore`: the session's history as it stood when the turn began.
 * - `turnMessages`: that history followed by the turn's own input and user-role blocks, as the
 *   runtime appends them.
 * - `withMemoryBlock`: the prepared turn with its memory block replaced or removed, nothing else.
 * - `turnSystemPrompt`: the system prompt through the runtime's own function, from production's
 *   blocks with the compared memory block in the memory slot. The block keeps its payload markers,
 *   so the transport lifts it into the turn tail exactly as in production.
 * - `turnSearchTool`: `search_memories` as the turn's own tool surface advertised it, or null.
 *
 * The instruction blocks are the ones production stored with the turn (`agent_turns.prepared`):
 * mode rules, delegation, presentation preferences, reaction set and skills, as they were then.
 * Production's memory block is the one thing taken out; it held the profile view next to the
 * records, so no condition carries a profile view (#348).
 *
 * Still not production's, and the same for every condition:
 * - The base prompt is the current code's, not the one of the release that answered the turn.
 * - `search_memories` is the only tool: the others need a sandbox and the network. A turn that
 *   asked for one can be answered with the mode's refusal.
 * - Threads are not rewound with the records (see `memory-conditions.ts`).
 * - The history is cut to its tail, measured with tool outputs and reasoning included: one long
 *   reply can leave a turn with no history at all. The whole history of a long chat would multiply
 *   the cost of every request and change nothing between the conditions compared. A group turn
 *   carries the recent timeline in its own input either way.
 */
import type { ModelMessage, UserContent } from "ai";

import { createOsinaraAgent } from "../../../agent/agent.js";
import { AppError } from "../../../agent/lib/app-error.js";
import { database } from "../../../agent/lib/database.js";
import { isTurnMemoryContext } from "../../../agent/lib/prompt/turn-memory-context.js";
import { resolveToolSurface } from "../../../agent/tools/capabilities.js";
import type { SessionAuth, SessionAuthContext } from "../../../agent/runtime/context.js";
import { preparedSystemPrompt } from "../../../agent/runtime/prompt/system-prompt.js";
import { turnInputMessages } from "../../../agent/runtime/prompt/turn-instructions.js";
import type { ToolDefinition } from "../../../agent/runtime/tool.js";
import type { PreparedTurn, TurnChannel } from "../../../agent/runtime/turn/turn-types.js";

// The surface maps hold tools of different input types; the harness never relies on them here.
type AnyToolDefinition = ToolDefinition<any, any>;

/** About the last exchange or two of a private chat; a group turn carries its timeline in the input. */
export const HISTORY_TAIL_MAX_CHARACTERS = 12_000;

const BASE_PROMPT = createOsinaraAgent().basePrompt;

export interface StoredTurn {
  auth: SessionAuth;
  channel: TurnChannel;
  input: { context: string[]; message?: UserContent };
  prepared: PreparedTurn;
  sessionId: string;
  startedAt: Date;
  turnId: string;
}

export async function loadStoredTurn(turnId: string): Promise<StoredTurn> {
  const row = (await database().query<{
    auth: SessionAuth; channel: TurnChannel; created_at: Date; input: StoredTurn["input"];
    prepared: PreparedTurn | null; session_id: string;
  }>(
    "SELECT auth, channel, input, prepared, session_id, created_at FROM agent_turns WHERE id = $1",
    [turnId],
  )).rows[0];
  if (row === undefined) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_TURN_MISSING",
      `Хода ${turnId} из эталона нет в копии базы. Восстановите ту же резервную копию, по которой собран эталон`,
    );
  }
  if (row.prepared === null) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_TURN_NOT_PREPARED",
      `У хода ${turnId} в копии нет подготовленных инструкций: прод не начал его отвечать. Уберите ход из эталона`,
    );
  }
  return {
    auth: row.auth, channel: row.channel, input: row.input, prepared: row.prepared,
    sessionId: row.session_id, startedAt: row.created_at, turnId,
  };
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
    ...turnInputMessages({
      context: turn.input.context, message: turn.input.message, userInstructions: turn.prepared.userInstructions,
    }),
  ];
}

/**
 * The memory slot is the one block that is a whole memory payload. A turn whose memory failed
 * carries the service notice there instead, and one without a question carries nothing: neither
 * says where production would have put records, so neither is measured.
 */
export function withMemoryBlock(prepared: PreparedTurn, memoryBlock: string | null): PreparedTurn {
  const slots = prepared.instructions.flatMap((block, index) => isTurnMemoryContext(block) ? [index] : []);
  if (slots.length !== 1) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_MEMORY_SLOT_INVALID",
      "В подготовленных инструкциях хода нет ровно одного блока памяти: подменить подборку негде. Уберите ход из эталона",
      { details: { memoryBlocks: slots.length } },
    );
  }
  const slot = slots[0]!;
  return {
    ...prepared,
    instructions: [
      ...prepared.instructions.slice(0, slot),
      ...(memoryBlock === null ? [] : [memoryBlock]),
      ...prepared.instructions.slice(slot + 1),
    ],
  };
}

export function turnSystemPrompt(prepared: PreparedTurn, memoryBlock: string | null): string {
  return preparedSystemPrompt(BASE_PROMPT, withMemoryBlock(prepared, memoryBlock));
}

/**
 * The definition production's surface resolver gives this turn: absent where the group's grants
 * leave it out, and with the description the turn's mode advertises. Only its descriptor is used
 * (`answer-turn.ts` runs the product's own tool). The grants are read from the copy as the backup
 * left them, not as they stood at the question.
 */
export async function turnSearchTool(
  turn: StoredTurn,
  messages: readonly ModelMessage[],
): Promise<AnyToolDefinition | null> {
  const surface = await resolveToolSurface({
    channel: turn.channel, messages, session: { auth: withoutRetiredTools(turn.auth), id: turn.sessionId },
  });
  return surface.search_memories ?? null;
}

/**
 * Group tools the product has removed since, still named in the stored rights of older turns:
 * `manage_memory_conflict` until #340. The policy treats one unknown name as corruption and denies
 * the whole group, so such a turn would be measured without the search production gave it.
 */
const RETIRED_GROUP_TOOL_NAMES: readonly string[] = ["manage_memory_conflict"];

function withoutRetiredTools(auth: SessionAuth): SessionAuth {
  const clean = (principal: SessionAuthContext | null): SessionAuthContext | null => {
    const allowlist = principal?.attributes.toolAllowlist;
    if (principal === null || !Array.isArray(allowlist)) return principal;
    return {
      ...principal,
      attributes: {
        ...principal.attributes,
        toolAllowlist: allowlist.filter((name: string) => !RETIRED_GROUP_TOOL_NAMES.includes(name)),
      },
    };
  };
  return { current: clean(auth.current), initiator: clean(auth.initiator) };
}
