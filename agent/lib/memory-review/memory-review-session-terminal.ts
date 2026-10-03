/** Session bookkeeping for completed memory-review batches, including late events after rotation. */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";

export async function terminalizeApplicationSession(
  client: PoolClient,
  input: {
    applicationSessionId: string;
    completedAt: Date;
    agentSessionId: string;
    outcome: "completed" | "failed";
  },
): Promise<void> {
  const result = await client.query(
    `UPDATE conversation_sessions
        SET completed_turns = completed_turns + CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
            last_activity_at = $3, pending_operation = false, agent_session_id = $2,
            task_state = CASE
              WHEN kind <> 'canonical' THEN $4::conversation_task_state
              ELSE task_state
            END,
            retired_at = CASE WHEN kind <> 'canonical' THEN $3 ELSE retired_at END,
            delete_after = CASE
              WHEN kind <> 'canonical' THEN $3 + $5 * interval '1 day'
              ELSE delete_after
            END
      WHERE id = $1 AND retired_at IS NULL
        AND (agent_session_id IS NULL OR agent_session_id = $2)`,
    [input.applicationSessionId, input.agentSessionId, input.completedAt, input.outcome,
      SESSION_RETENTION_DAYS],
  );
  if (result.rowCount !== 1) {
    // Rotation retires the chat, not the work its previous turn already completed. Settle that
    // exact batch without reopening or mutating either generation of the conversation.
    const retired = await client.query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND agent_session_id = $2 AND retired_at IS NOT NULL`,
      [input.applicationSessionId, input.agentSessionId],
    );
    if (retired.rowCount === 1) return;
    throw new AppError(
      "AGENT_MEMORY_REVIEW_SESSION_TERMINAL_INVALID",
      "Не удалось завершить контекст проверки памяти",
    );
  }
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NOT NULL AND kind <> 'canonical'`,
    [input.applicationSessionId],
  );
}
