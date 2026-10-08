/**
 * Durable conversation history of runtime sessions.
 *
 * Exports:
 * - `createSessionHistory`: registers a session with its initial history and carried-over state.
 * - `loadSessionHistory`: the current history generation with the session's state.
 * - `appendSessionHistory`: adds the messages a turn produced, after the current tail.
 * - `saveCompactionCounters`: the provider-reported prompt size the next compaction check starts from.
 * - `replaceSessionHistory`: writes a compacted history as a new generation; old rows stay as they were.
 * - `recordCompactionSummaryRefusal`: counts a summary request the model refused.
 * - `saveAnnouncedSkills`: the skill list the session's sandbox now holds.
 * - `loadApplicationSessionId`: the application session a runtime session belongs to.
 * - `loadInitiatorAuth`: who opened the session.
 *
 * Writers take a client inside the caller's transaction, so a history change commits together
 * with the journal record that caused it. Appends lock the session row; two writers of one
 * session never interleave positions.
 */
import type { ModelMessage } from "ai";
import type { PoolClient } from "pg";

import { AppError } from "../../lib/app-error.js";
import type { SessionAuthContext } from "../context.js";
import type { AnnouncedSkill } from "../skills/definition.js";
import { describeHistoryProblem } from "./model-message-shape.js";

export type HistoryClient = Pick<PoolClient, "query">;

export interface CompactionCounters {
  readonly inputTokens: number | null;
  readonly promptMessageCount: number | null;
}

export interface NewSessionHistory {
  readonly announcedSkills: readonly AnnouncedSkill[] | null;
  readonly applicationSessionId: string;
  /** The channel's JSON state, set by the channel on a new session. */
  readonly channelState: Record<string, unknown> | null;
  /** Who opened the session; every turn sees it as `auth.initiator`. */
  readonly initiatorAuth: SessionAuthContext | null;
  readonly compaction: CompactionCounters;
  readonly history: readonly ModelMessage[];
  readonly parentSessionId: string | null;
  /** Sandbox runner metadata; a new session opens its sandbox on first use. */
  readonly sandbox: Record<string, unknown> | null;
  readonly sessionId: string;
  readonly source: "imported" | "runtime";
  readonly todo: Record<string, unknown> | null;
}

export interface SessionHistory {
  readonly announcedSkills: readonly AnnouncedSkill[] | null;
  readonly compaction: CompactionCounters;
  /** Summary requests the model refused in a row since this session's last compaction. */
  readonly compactionSummaryRefusals: number;
  readonly generation: number;
  readonly messages: ModelMessage[];
  readonly todo: Record<string, unknown> | null;
}

function serializeMessages(messages: readonly ModelMessage[]): string[] {
  const problem = describeHistoryProblem(messages);
  if (problem !== null) {
    throw new AppError("AGENT_SESSION_HISTORY_MESSAGE_INVALID", `Сообщение нельзя сохранить в историю: ${problem}`);
  }
  return messages.map((message) => JSON.stringify(message));
}

async function insertMessages(
  client: HistoryClient,
  input: { generation: number; firstPosition: number; messages: readonly string[]; sessionId: string; turnId: string | null },
): Promise<void> {
  if (input.messages.length === 0) return;
  await client.query(
    `INSERT INTO agent_session_history (session_id, generation, position, turn_id, message)
     SELECT $1, $2, $3 + entry.ordinality - 1, $4, entry.message::json
       FROM unnest($5::text[]) WITH ORDINALITY AS entry(message, ordinality)`,
    [input.sessionId, input.generation, input.firstPosition, input.turnId, input.messages],
  );
}

/** Returns `false` and writes nothing when the session already exists. */
export async function createSessionHistory(client: HistoryClient, input: NewSessionHistory): Promise<boolean> {
  const messages = serializeMessages(input.history);
  const created = await client.query(
    `INSERT INTO agent_session_state
       (session_id, application_session_id, parent_session_id, source, compaction_input_tokens,
        compaction_prompt_message_count, announced_skills, todo, sandbox_state, channel_state, initiator_auth)
     VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8::json, $9::json, $10::json, $11::json)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING session_id`,
    [
      input.sessionId, input.applicationSessionId, input.parentSessionId, input.source,
      input.compaction.inputTokens, input.compaction.promptMessageCount,
      input.announcedSkills === null ? null : JSON.stringify(input.announcedSkills),
      input.todo === null ? null : JSON.stringify(input.todo),
      input.sandbox === null ? null : JSON.stringify(input.sandbox),
      input.channelState === null ? null : JSON.stringify(input.channelState),
      input.initiatorAuth === null ? null : JSON.stringify(input.initiatorAuth),
    ],
  );
  if (created.rowCount !== 1) return false;
  await insertMessages(client, { generation: 0, firstPosition: 0, messages, sessionId: input.sessionId, turnId: null });
  return true;
}

export async function loadSessionHistory(client: HistoryClient, sessionId: string): Promise<SessionHistory> {
  const state = (await client.query<{
    announced_skills: AnnouncedSkill[] | null;
    compaction_input_tokens: number | null;
    compaction_prompt_message_count: number | null;
    compaction_summary_refusals: number;
    history_generation: number;
    todo: Record<string, unknown> | null;
  }>(
    `SELECT history_generation, compaction_input_tokens, compaction_prompt_message_count, compaction_summary_refusals,
            announced_skills, todo
       FROM agent_session_state WHERE session_id = $1`,
    [sessionId],
  )).rows[0];
  if (!state) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  }
  const rows = (await client.query<{ message: ModelMessage }>(
    "SELECT message FROM agent_session_history WHERE session_id = $1 AND generation = $2 ORDER BY position",
    [sessionId, state.history_generation],
  )).rows;
  return {
    announcedSkills: state.announced_skills,
    compaction: { inputTokens: state.compaction_input_tokens, promptMessageCount: state.compaction_prompt_message_count },
    compactionSummaryRefusals: state.compaction_summary_refusals,
    generation: state.history_generation,
    messages: rows.map((row) => row.message),
    todo: state.todo,
  };
}

export async function appendSessionHistory(
  client: HistoryClient,
  input: { messages: readonly ModelMessage[]; sessionId: string; turnId: string },
): Promise<void> {
  const messages = serializeMessages(input.messages);
  const state = (await client.query<{ generation: number }>(
    "SELECT history_generation AS generation FROM agent_session_state WHERE session_id = $1 FOR UPDATE",
    [input.sessionId],
  )).rows[0];
  if (!state) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId: input.sessionId } });
  }
  const tail = (await client.query<{ next_position: number }>(
    `SELECT coalesce(max(position) + 1, 0) AS next_position FROM agent_session_history
      WHERE session_id = $1 AND generation = $2`,
    [input.sessionId, state.generation],
  )).rows[0]!;
  await insertMessages(client, {
    generation: state.generation, firstPosition: tail.next_position, messages, sessionId: input.sessionId, turnId: input.turnId,
  });
  await client.query("UPDATE agent_session_state SET updated_at = now() WHERE session_id = $1", [input.sessionId]);
}

export async function saveCompactionCounters(
  client: HistoryClient,
  input: { counters: CompactionCounters; sessionId: string },
): Promise<void> {
  const updated = await client.query(
    `UPDATE agent_session_state SET compaction_input_tokens = $2, compaction_prompt_message_count = $3, updated_at = now()
      WHERE session_id = $1`,
    [input.sessionId, input.counters.inputTokens, input.counters.promptMessageCount],
  );
  if (updated.rowCount !== 1) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId: input.sessionId } });
  }
}

/**
 * The model refused to summarize this session's history: the next compaction asks for less. Kept
 * outside the failing turn's transaction, which rolls back, so the refusal is not forgotten.
 */
export async function recordCompactionSummaryRefusal(client: HistoryClient, sessionId: string): Promise<number> {
  const updated = (await client.query<{ refusals: number }>(
    `UPDATE agent_session_state
        SET compaction_summary_refusals = compaction_summary_refusals + 1, updated_at = now()
      WHERE session_id = $1
      RETURNING compaction_summary_refusals AS refusals`,
    [sessionId],
  )).rows[0];
  if (!updated) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  }
  return updated.refusals;
}

/**
 * The new generation starts without provider counters, which measured the previous one, and
 * without refusals: the summary that replaced the history was accepted.
 */
export async function replaceSessionHistory(
  client: HistoryClient,
  input: { messages: readonly ModelMessage[]; sessionId: string; turnId: string },
): Promise<void> {
  const messages = serializeMessages(input.messages);
  const state = (await client.query<{ generation: number }>(
    `UPDATE agent_session_state
        SET history_generation = history_generation + 1, compaction_input_tokens = NULL,
            compaction_prompt_message_count = NULL, compaction_summary_refusals = 0, updated_at = now()
      WHERE session_id = $1
      RETURNING history_generation AS generation`,
    [input.sessionId],
  )).rows[0];
  if (!state) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId: input.sessionId } });
  }
  await insertMessages(client, { firstPosition: 0, generation: state.generation, messages, sessionId: input.sessionId, turnId: input.turnId });
}

export async function saveAnnouncedSkills(
  client: HistoryClient,
  input: { sessionId: string; skills: readonly AnnouncedSkill[] },
): Promise<void> {
  const updated = await client.query(
    "UPDATE agent_session_state SET announced_skills = $2::json, updated_at = now() WHERE session_id = $1",
    [input.sessionId, JSON.stringify(input.skills)],
  );
  if (updated.rowCount !== 1) {
    throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId: input.sessionId } });
  }
}

export async function loadApplicationSessionId(client: HistoryClient, sessionId: string): Promise<string> {
  const row = (await client.query<{ application_session_id: string }>(
    "SELECT application_session_id FROM agent_session_state WHERE session_id = $1", [sessionId],
  )).rows[0];
  if (!row) throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  return row.application_session_id;
}

export async function loadInitiatorAuth(client: HistoryClient, sessionId: string): Promise<SessionAuthContext | null> {
  const row = (await client.query<{ initiator_auth: SessionAuthContext | null }>(
    "SELECT initiator_auth FROM agent_session_state WHERE session_id = $1", [sessionId],
  )).rows[0];
  if (!row) throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  return row.initiator_auth;
}
