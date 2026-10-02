/**
 * Turn journal: what a turn has done, so a restart or a button press continues without repeating it.
 *
 * Exports:
 * - `inJournalTransaction`: runs writers that must commit together.
 * - `createTurn`, `loadTurn`, `claimTurn`, `findWaitingTurn`: the turn row.
 * - `releaseOtherRunners`, `listRunningRootTurns`: turns an earlier process left running.
 * - `savePreparedTurn`, `parkTurn`, `addPendingContext`, `markHistoryStarted`, `finishTurn`: its lifecycle.
 * - `sessionAwaitsApproval`: whether a tool approval of the session is still unanswered.
 * - `recordStep`, `loadStep`, `markStepTextEmitted`, `completeStep`: one model step and its tool calls.
 * - `updateToolCall`, `recordInputResponse`: a tool call's state, result and a person's answer.
 * - `parkToolCall`, `findChildTurn`, `latestSessionTurn`: an `agent` call waiting on its child turn.
 * - `findTurnCaller`: the `agent` call a child turn — or a continuation of one — works for.
 * - `findInputRequests`: requests the session's calls raised, by id.
 *
 * Writers take a client inside the caller's transaction: a step's model response, its tool calls
 * and the history it appends commit together or not at all.
 */
import type { ModelMessage } from "ai";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../../lib/app-error.js";
import type { SessionAuth } from "../context.js";
import type { InputRequest, InputResponse } from "../hitl/types.js";
import type { ToolResultOutput } from "./tool-calls.js";
import type {
  PreparedTurn,
  SubagentInputRequest,
  ToolCallRecord,
  ToolCallState,
  TurnChannel,
  TurnKind,
  TurnRecord,
  TurnStartInput,
  TurnStatus,
  TurnStepRecord,
} from "./turn-types.js";

export type JournalClient = Pick<PoolClient, "query">;
export type JournalDatabase = Pick<Pool, "connect">;

export async function inJournalTransaction<T>(pool: JournalDatabase, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface TurnRow {
  auth: SessionAuth;
  channel: TurnChannel;
  error_code: string | null;
  error_message: string | null;
  final_text: string | null;
  history_started: boolean;
  id: string;
  input: TurnStartInput;
  kind: TurnKind;
  next_step_index: number;
  parent_call_id: string | null;
  parent_turn_id: string | null;
  pending_context: string[] | null;
  prepared: PreparedTurn | null;
  resumes_turn_id: string | null;
  runner_id: string | null;
  sequence: number;
  session_id: string;
  status: TurnStatus;
}

const TURN_COLUMNS = `id, session_id, sequence, kind, status, parent_turn_id, parent_call_id, auth, channel, input,
  prepared, pending_context, resumes_turn_id, history_started, next_step_index, runner_id, final_text, error_code,
  error_message`;

function toTurn(row: TurnRow): TurnRecord {
  return {
    auth: row.auth,
    channel: row.channel,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    finalText: row.final_text,
    historyStarted: row.history_started,
    id: row.id,
    input: row.input,
    kind: row.kind,
    nextStepIndex: row.next_step_index,
    parentCallId: row.parent_call_id,
    parentTurnId: row.parent_turn_id,
    pendingContext: row.pending_context === null ? [] : row.pending_context,
    prepared: row.prepared,
    resumesTurnId: row.resumes_turn_id,
    runnerId: row.runner_id,
    sequence: row.sequence,
    sessionId: row.session_id,
    status: row.status,
  };
}

function missingTurn(turnId: string): AppError {
  return new AppError("AGENT_TURN_NOT_FOUND", "Ход агента не найден", { details: { turnId } });
}

export async function createTurn(client: JournalClient, input: {
  readonly auth: SessionAuth;
  readonly channel: TurnChannel;
  readonly id: string;
  readonly input: TurnStartInput;
  readonly kind: TurnKind;
  readonly parent: { readonly callId: string; readonly turnId: string } | null;
  readonly resumesTurnId: string | null;
  readonly sessionId: string;
}): Promise<TurnRecord> {
  // The session row lock serializes turn creation, so sequence numbers never collide.
  const session = await client.query("SELECT 1 FROM agent_session_state WHERE session_id = $1 FOR UPDATE", [input.sessionId]);
  if (session.rowCount !== 1) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId: input.sessionId } });
  }
  const row = (await client.query<TurnRow>(
    `INSERT INTO agent_turns
       (id, session_id, sequence, kind, status, parent_turn_id, parent_call_id, resumes_turn_id, auth, channel, input)
     SELECT $1, $2, coalesce(max(sequence) + 1, 0), $3, 'running', $4, $5, $6, $7::json, $8::json, $9::json
       FROM agent_turns WHERE session_id = $2
     RETURNING ${TURN_COLUMNS}`,
    [input.id, input.sessionId, input.kind, input.parent?.turnId ?? null, input.parent?.callId ?? null, input.resumesTurnId,
      JSON.stringify(input.auth), JSON.stringify(input.channel), JSON.stringify(input.input)],
  )).rows[0]!;
  return toTurn(row);
}

export async function loadTurn(client: JournalClient, turnId: string): Promise<TurnRecord> {
  const row = (await client.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM agent_turns WHERE id = $1`, [turnId])).rows[0];
  if (!row) throw missingTurn(turnId);
  return toTurn(row);
}

/** Marks the start of a step's history writes; used when a continuation settles a parked step. */
export async function markHistoryStarted(client: JournalClient, turnId: string): Promise<void> {
  await updateTurn(client, turnId, "history_started = true", []);
}

/**
 * Takes a running turn for this process; returns null when another process owns it, it is not
 * running, or an earlier turn of its session still runs: a session's turns run one at a time, in
 * the order they were created (Eve's `queue` turn policy).
 */
export async function claimTurn(client: JournalClient, turnId: string, runnerId: string): Promise<TurnRecord | null> {
  const row = (await client.query<TurnRow>(
    `UPDATE agent_turns turn SET runner_id = $2, updated_at = now()
      WHERE turn.id = $1 AND turn.status = 'running' AND (turn.runner_id IS NULL OR turn.runner_id = $2)
        AND NOT EXISTS (
          SELECT 1 FROM agent_turns earlier
           WHERE earlier.session_id = turn.session_id AND earlier.status = 'running' AND earlier.sequence < turn.sequence)
      RETURNING ${TURN_COLUMNS}`,
    [turnId, runnerId],
  )).rows[0];
  return row ? toTurn(row) : null;
}

/**
 * At startup, running turns of earlier processes become claimable again. One backend process runs
 * turns, so any other runner is a process that is gone.
 */
export async function releaseOtherRunners(client: JournalClient, runnerId: string): Promise<void> {
  await client.query(
    "UPDATE agent_turns SET runner_id = NULL, updated_at = now() WHERE status = 'running' AND runner_id <> $1",
    [runnerId],
  );
}

/** Running turns that no parent drives, oldest first in each session. */
export async function listRunningRootTurns(client: JournalClient): Promise<TurnRecord[]> {
  const rows = (await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM agent_turns WHERE status = 'running' AND parent_turn_id IS NULL ORDER BY session_id, sequence`,
  )).rows;
  return rows.map(toTurn);
}

/** The session's turn that waits for a person, locked for the caller's transaction. */
export async function findWaitingTurn(client: JournalClient, sessionId: string): Promise<TurnRecord | null> {
  const row = (await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM agent_turns WHERE session_id = $1 AND status = 'waiting_input' FOR UPDATE`,
    [sessionId],
  )).rows[0];
  return row ? toTurn(row) : null;
}

export async function savePreparedTurn(client: JournalClient, turnId: string, prepared: PreparedTurn): Promise<void> {
  await client.query("UPDATE agent_turns SET prepared = $2::json, updated_at = now() WHERE id = $1",
    [turnId, JSON.stringify(prepared)]);
}

async function updateTurn(client: JournalClient, turnId: string, assignments: string, values: readonly unknown[]): Promise<void> {
  const updated = await client.query(`UPDATE agent_turns SET ${assignments}, updated_at = now() WHERE id = $1`, [turnId, ...values]);
  if (updated.rowCount !== 1) throw missingTurn(turnId);
}

/** The turn waits for a person; its input and the pending note are in history by now. */
export async function parkTurn(client: JournalClient, turnId: string): Promise<void> {
  await updateTurn(client, turnId, "status = 'waiting_input', history_started = true, runner_id = NULL", []);
}

/** Keeps the context lines of a partial answer for the continuation turn. */
export async function addPendingContext(client: JournalClient, turnId: string, context: readonly string[]): Promise<void> {
  if (context.length === 0) return;
  await updateTurn(client, turnId, "pending_context = (coalesce(pending_context::jsonb, '[]'::jsonb) || $2::jsonb)::json",
    [JSON.stringify(context)]);
}

/** A child's request waiting behind an `agent` call counts too: it may be an approval. */
export async function sessionAwaitsApproval(client: JournalClient, sessionId: string): Promise<boolean> {
  const row = (await client.query<{ awaits: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_turns t JOIN agent_tool_calls c ON c.turn_id = t.id
        WHERE t.session_id = $1 AND t.status = 'waiting_input'
          AND c.state = 'awaiting_input' AND c.input_request->>'kind' IN ('tool-approval', 'subagent')
     ) AS awaits`,
    [sessionId],
  )).rows[0]!;
  return row.awaits;
}

export async function finishTurn(client: JournalClient, turnId: string, outcome:
  | { readonly finalText: string | null; readonly status: "completed" }
  | { readonly errorCode: string; readonly errorMessage: string; readonly status: "failed" }
  | { readonly status: "cancelled" },
): Promise<void> {
  if (outcome.status === "completed") {
    await updateTurn(client, turnId, "status = 'completed', final_text = $2, runner_id = NULL, completed_at = now()", [outcome.finalText]);
    return;
  }
  if (outcome.status === "failed") {
    await updateTurn(client, turnId, "status = 'failed', error_code = $2, error_message = $3, runner_id = NULL, completed_at = now()",
      [outcome.errorCode, outcome.errorMessage]);
    return;
  }
  await updateTurn(client, turnId, "status = 'cancelled', runner_id = NULL, completed_at = now()", []);
}

interface StepRow {
  completed_at: Date | null;
  text_emitted_at: Date | null;
  finish_reason: string;
  response: ModelMessage[];
  step_index: number;
}

interface CallRow {
  call_id: string;
  input: Record<string, unknown>;
  input_request: InputRequest | SubagentInputRequest | null;
  input_response: InputResponse | null;
  output: ToolResultOutput | null;
  position: number;
  state: ToolCallState;
  step_index: number;
  tool_name: string;
}

function toCall(row: CallRow): ToolCallRecord {
  return {
    callId: row.call_id,
    input: row.input,
    inputRequest: row.input_request,
    inputResponse: row.input_response,
    output: row.output,
    position: row.position,
    state: row.state,
    stepIndex: row.step_index,
    toolName: row.tool_name,
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

export async function recordStep(client: JournalClient, input: {
  readonly calls: readonly Omit<ToolCallRecord, "stepIndex">[];
  readonly finishReason: string;
  readonly response: readonly ModelMessage[];
  readonly stepIndex: number;
  readonly turnId: string;
  readonly usage: unknown;
}): Promise<void> {
  await client.query(
    `INSERT INTO agent_turn_steps (turn_id, step_index, response, finish_reason, usage)
     VALUES ($1, $2, $3::json, $4, $5::json)`,
    [input.turnId, input.stepIndex, JSON.stringify(input.response), input.finishReason,
      input.usage === undefined ? null : JSON.stringify(input.usage)],
  );
  for (const call of input.calls) {
    await client.query(
      `INSERT INTO agent_tool_calls
         (turn_id, step_index, call_id, position, tool_name, input, state, input_request, input_response, output)
       VALUES ($1, $2, $3, $4, $5, $6::json, $7, $8::json, $9::json, $10::json)`,
      [input.turnId, input.stepIndex, call.callId, call.position, call.toolName, JSON.stringify(call.input),
        call.state, jsonOrNull(call.inputRequest), jsonOrNull(call.inputResponse), jsonOrNull(call.output)],
    );
  }
}

export async function loadStep(client: JournalClient, turnId: string, stepIndex: number): Promise<{
  readonly calls: ToolCallRecord[];
  readonly step: TurnStepRecord;
} | null> {
  const step = (await client.query<StepRow>(
    `SELECT step_index, response, finish_reason, text_emitted_at, completed_at
       FROM agent_turn_steps WHERE turn_id = $1 AND step_index = $2`,
    [turnId, stepIndex],
  )).rows[0];
  if (!step) return null;
  const calls = (await client.query<CallRow>(
    `SELECT call_id, step_index, position, tool_name, input, state, input_request, input_response, output
       FROM agent_tool_calls WHERE turn_id = $1 AND step_index = $2 ORDER BY position`,
    [turnId, stepIndex],
  )).rows;
  return {
    calls: calls.map(toCall),
    step: {
      completed: step.completed_at !== null,
      finishReason: step.finish_reason,
      response: step.response,
      stepIndex: step.step_index,
      textEmitted: step.text_emitted_at !== null,
    },
  };
}

export async function updateToolCall(client: JournalClient, input: {
  readonly callId: string;
  readonly output: ToolResultOutput | null;
  readonly state: ToolCallState;
  readonly turnId: string;
}): Promise<void> {
  const updated = await client.query(
    `UPDATE agent_tool_calls SET state = $3, output = $4::json, updated_at = now()
      WHERE turn_id = $1 AND call_id = $2`,
    [input.turnId, input.callId, input.state, jsonOrNull(input.output)],
  );
  if (updated.rowCount !== 1) {
    throw new AppError("AGENT_TOOL_CALL_NOT_FOUND", "Вызов инструмента не найден", { details: { callId: input.callId, turnId: input.turnId } });
  }
}

/** Keeps a person's answer on its call; returns false when the call no longer waits for one. */
export async function recordInputResponse(client: JournalClient, input: {
  readonly callId: string;
  readonly response: InputResponse;
  readonly turnId: string;
}): Promise<boolean> {
  const updated = await client.query(
    `UPDATE agent_tool_calls SET input_response = $3::json, updated_at = now()
      WHERE turn_id = $1 AND call_id = $2 AND state = 'awaiting_input'`,
    [input.turnId, input.callId, JSON.stringify(input.response)],
  );
  return updated.rowCount === 1;
}

export async function markStepTextEmitted(client: JournalClient, turnId: string, stepIndex: number): Promise<void> {
  await client.query("UPDATE agent_turn_steps SET text_emitted_at = now() WHERE turn_id = $1 AND step_index = $2", [turnId, stepIndex]);
}

/** The step's messages are in history: the turn moves to the next step. */
export async function completeStep(client: JournalClient, turnId: string, stepIndex: number): Promise<void> {
  await client.query("UPDATE agent_turn_steps SET completed_at = now() WHERE turn_id = $1 AND step_index = $2", [turnId, stepIndex]);
  await updateTurn(client, turnId, "next_step_index = $2 + 1, history_started = true", [stepIndex]);
}

/** An `agent` call whose child turn waits for a person; its requests are shown by the parent. */
export async function parkToolCall(client: JournalClient, input: {
  readonly callId: string;
  readonly request: SubagentInputRequest;
  readonly turnId: string;
}): Promise<void> {
  const updated = await client.query(
    `UPDATE agent_tool_calls SET state = 'awaiting_input', input_request = $3::json, output = NULL, updated_at = now()
      WHERE turn_id = $1 AND call_id = $2`,
    [input.turnId, input.callId, JSON.stringify(input.request)],
  );
  if (updated.rowCount !== 1) {
    throw new AppError("AGENT_TOOL_CALL_NOT_FOUND", "Вызов инструмента не найден", { details: { callId: input.callId, turnId: input.turnId } });
  }
}

// A continuation chain grows by one turn per answered request; far beyond any real conversation.
const MAX_CONTINUATION_DEPTH = 64;

/**
 * The call and the turn of the caller, for a child turn or any continuation of one: only the
 * child's first turn records its parent (one child per call), its continuations resume it.
 */
export async function findTurnCaller(
  client: JournalClient,
  turnId: string,
): Promise<{ readonly callId: string; readonly turn: TurnRecord } | null> {
  const row = (await client.query<TurnRow & { caller_call_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_turn_id, parent_call_id, resumes_turn_id, 0 AS depth FROM agent_turns WHERE id = $1
       UNION ALL
       SELECT turn.id, turn.parent_turn_id, turn.parent_call_id, turn.resumes_turn_id, chain.depth + 1
         FROM agent_turns turn JOIN chain ON turn.id = chain.resumes_turn_id
        WHERE chain.parent_turn_id IS NULL AND chain.depth < $2
     )
     SELECT ${TURN_COLUMNS.split(",").map((column) => `caller.${column.trim()}`).join(", ")}, chain.parent_call_id AS caller_call_id
       FROM chain JOIN agent_turns caller ON caller.id = chain.parent_turn_id
      LIMIT 1`,
    [turnId, MAX_CONTINUATION_DEPTH],
  )).rows[0];
  return row ? { callId: row.caller_call_id, turn: toTurn(row) } : null;
}

/** The first turn of the child session an `agent` call started, if it did. */
export async function findChildTurn(client: JournalClient, parentTurnId: string, callId: string): Promise<TurnRecord | null> {
  const row = (await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM agent_turns WHERE parent_turn_id = $1 AND parent_call_id = $2`,
    [parentTurnId, callId],
  )).rows[0];
  return row ? toTurn(row) : null;
}

/** Requests of the session's calls by id, for answers that arrive after their request stopped waiting. */
export async function findInputRequests(client: JournalClient, sessionId: string, requestIds: readonly string[]): Promise<Map<string, InputRequest>> {
  const rows = (await client.query<{ input_request: InputRequest }>(
    `SELECT c.input_request FROM agent_tool_calls c JOIN agent_turns t ON t.id = c.turn_id
      WHERE t.session_id = $1 AND c.input_request->>'kind' IN ('question', 'tool-approval')
        AND c.input_request->>'requestId' = ANY($2::text[])`,
    [sessionId, requestIds],
  )).rows;
  return new Map(rows.map((row) => [row.input_request.requestId, row.input_request]));
}

/** The session's newest turn: a child that continued after an answer runs in a continuation turn. */
export async function latestSessionTurn(client: JournalClient, sessionId: string): Promise<TurnRecord> {
  const row = (await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM agent_turns WHERE session_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [sessionId],
  )).rows[0];
  if (!row) throw new AppError("AGENT_TURN_NOT_FOUND", "Ход агента не найден", { details: { sessionId } });
  return toTurn(row);
}
