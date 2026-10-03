/**
 * Session state of the built-in tools: the todo list and the read-before-write stamps.
 *
 * Exports:
 * - `SessionToolState`: what a tool reads and writes through `ctx.state`.
 * - `sessionToolState`: the store over `agent_session_state` for one session.
 * - `clearReadFileState`: forgets every stamp; compaction calls it in its own transaction.
 * - `TodoState`, `TodoItem`, `ReadFileStamp`: the stored shapes.
 *
 * Both are kept next to the history, so they survive turns and restarts. Each stamp is written on
 * its own key, so parallel reads in one step cannot overwrite each other.
 */
import type { Pool } from "pg";

import { AppError } from "../../lib/app-error.js";

export interface TodoItem {
  readonly content: string;
  readonly priority: "high" | "low" | "medium";
  readonly status: "cancelled" | "completed" | "in_progress" | "pending";
}

export interface TodoState {
  readonly items: readonly TodoItem[];
}

export interface ReadFileStamp {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly filePath: string;
}

export interface SessionToolState {
  readTodo(): Promise<TodoState | null>;
  writeTodo(state: TodoState): Promise<void>;
  readFileStamp(path: string): Promise<ReadFileStamp | undefined>;
  writeFileStamp(path: string, stamp: ReadFileStamp): Promise<void>;
}

type StateClient = Pick<Pool, "query">;

function missingSession(sessionId: string): AppError {
  return new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
}

async function updateState(client: StateClient, sessionId: string, assignment: string, values: readonly unknown[]): Promise<void> {
  const updated = await client.query(
    `UPDATE agent_session_state SET ${assignment}, updated_at = now() WHERE session_id = $1`,
    [sessionId, ...values],
  );
  if (updated.rowCount !== 1) throw missingSession(sessionId);
}

export function sessionToolState(client: StateClient, sessionId: string): SessionToolState {
  return {
    async readTodo() {
      const row = (await client.query<{ todo: TodoState | null }>(
        "SELECT todo FROM agent_session_state WHERE session_id = $1", [sessionId],
      )).rows[0];
      if (!row) throw missingSession(sessionId);
      return row.todo;
    },
    async writeTodo(state) {
      await updateState(client, sessionId, "todo = $2::json", [JSON.stringify(state)]);
    },
    async readFileStamp(path) {
      const row = (await client.query<{ stamp: ReadFileStamp | null }>(
        "SELECT read_file_state -> $2 AS stamp FROM agent_session_state WHERE session_id = $1", [sessionId, path],
      )).rows[0];
      if (!row) throw missingSession(sessionId);
      return row.stamp ?? undefined;
    },
    async writeFileStamp(path, stamp) {
      await updateState(client, sessionId, "read_file_state = jsonb_set(read_file_state, ARRAY[$2::text], $3::jsonb)",
        [path, JSON.stringify(stamp)]);
    },
  };
}

export async function clearReadFileState(client: StateClient, sessionId: string): Promise<void> {
  await updateState(client, sessionId, "read_file_state = '{}'::jsonb", []);
}
