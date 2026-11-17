/**
 * What a background task did last, read from its turn journal (#519).
 *
 * Exports:
 * - `lastBackgroundTaskTools`: the task's latest tool calls as short lines, newest first, for the status
 *   and for an outcome whose summary turn failed.
 * - `journalOutcomeText`: that outcome — what the task did last, when it could not say it itself.
 *
 * A line names the tool and the file or command it worked on, cut short; nothing else of the input.
 */
import type { Pool } from "pg";

// Fields a call names its file or command by, in the order a line prefers them.
const SUBJECT_FIELDS = ["filePath", "path", "pattern", "command", "url", "query"] as const;
const SUBJECT_MAX_LENGTH = 120;

function subject(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  for (const field of SUBJECT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim()) {
      const line = value.replace(/\s+/gu, " ").trim();
      return line.length <= SUBJECT_MAX_LENGTH ? line : `${line.slice(0, SUBJECT_MAX_LENGTH - 1)}…`;
    }
  }
  return null;
}

export async function lastBackgroundTaskTools(
  database: Pick<Pool, "query">,
  agentSessionId: string | null,
  limit: number,
): Promise<string[]> {
  if (agentSessionId === null) return [];
  const result = await database.query<{ input: unknown; tool_name: string }>(
    `SELECT call.tool_name, call.input
       FROM agent_tool_calls call
       JOIN agent_turns turn ON turn.id = call.turn_id
      WHERE turn.session_id = $1
      ORDER BY call.created_at DESC, call.step_index DESC, call.position DESC
      LIMIT $2`,
    [agentSessionId, limit],
  );
  return result.rows.map((row) => {
    const about = subject(row.input);
    return about === null ? row.tool_name : `${row.tool_name} ${about}`;
  });
}

export function journalOutcomeText(lastTools: readonly string[]): string {
  return lastTools.length === 0
    ? "The task could not write a summary and made no tool calls."
    : `The task could not write a summary. Its last actions, newest first: ${lastTools.join("; ")}.`;
}
