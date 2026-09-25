/**
 * Scheduler sweep for wake-up runs that nothing else will close.
 *
 * Export:
 * - `recoverOrphanedConversationRuns`: closes runs whose queue item ended while the run stayed open.
 *
 * A wake-up schedule stays leased without a lease timer while its run is open, so the scheduler's
 * own expiry never frees it. Normally the run is closed by its turn's terminal event. When the
 * queue item ended without that — the observer gave up — the sweep closes the run instead:
 * - no turn was admitted and the admission deadline has passed: the turn can never start, so the
 *   wake-up is parked exactly like one that never reached Eve;
 * - a turn was admitted but has not reported long after its cancellation was requested: the run
 *   fails as lost, and the usual completion decides whether the schedule may run again, which it
 *   does not when a message of that turn may already have gone out.
 */
import type { PoolClient } from "pg";

import {
  AGENT_SCHEDULE_CONVERSATION_ADMISSION_MARGIN_MILLISECONDS,
  AGENT_SCHEDULE_CONVERSATION_TURN_LOST_MILLISECONDS,
} from "../agent-schedules/agent-schedule-config.js";
import { finishActiveAgentScheduleRun } from "../agent-schedules/agent-schedule-run-completion.js";
import { failUnstartedRun, WAKEUP_NOT_STARTED_CODE, withdrawUnstartedRun } from "./conversation-wakeup-transitions.js";

const ORPHAN_SWEEP_LIMIT = 10;
export const WAKEUP_TURN_LOST_CODE = "AGENT_CONVERSATION_WAKEUP_TURN_LOST";

export async function recoverOrphanedConversationRuns(client: PoolClient, now: Date): Promise<void> {
  const orphans = await client.query<{
    application_session_id: string | null;
    eve_session_id: string;
    eve_turn_id: string | null;
    run_id: string;
    schedule_id: string;
  }>(
    `SELECT run.id::text AS run_id, run.schedule_id::text, run.application_session_id::text,
            run.eve_session_id, run.eve_turn_id
       FROM agent_schedule_runs run
       JOIN agent_schedules schedule ON schedule.id = run.schedule_id
        AND schedule.status = 'leased' AND schedule.lease_token = run.lease_token
       JOIN telegram_ingress_wakeups wakeup ON wakeup.run_id = run.id
      WHERE run.recovery_protocol = 2 AND run.status = 'running'
        AND wakeup.status IN ('completed', 'failed') AND wakeup.admission_deadline_at IS NOT NULL
        AND ((run.eve_turn_id IS NULL
              AND wakeup.admission_deadline_at < $1::timestamptz - ($2 * interval '1 millisecond'))
          OR (run.eve_turn_id IS NOT NULL
              AND wakeup.completed_at < $1::timestamptz - ($3 * interval '1 millisecond')))
      ORDER BY run.created_at, run.id
      FOR UPDATE OF run, schedule SKIP LOCKED
      LIMIT $4`,
    [now, AGENT_SCHEDULE_CONVERSATION_ADMISSION_MARGIN_MILLISECONDS, AGENT_SCHEDULE_CONVERSATION_TURN_LOST_MILLISECONDS, ORPHAN_SWEEP_LIMIT],
  );
  for (const orphan of orphans.rows) {
    if (orphan.eve_turn_id === null) {
      await withdrawUnstartedRun(client, orphan.schedule_id, orphan.run_id, WAKEUP_NOT_STARTED_CODE);
      continue;
    }
    if (orphan.application_session_id === null) {
      // Retention already removed the conversation, so completion cannot find the run by it; left
      // open, the run would be picked again every minute and crowd out every later orphan.
      await failUnstartedRun(client, orphan.schedule_id, orphan.run_id, WAKEUP_TURN_LOST_CODE);
      continue;
    }
    await finishActiveAgentScheduleRun(client, {
      applicationSessionId: orphan.application_session_id,
      completedAt: now,
      eveSessionId: orphan.eve_session_id,
      outcome: { errorCode: WAKEUP_TURN_LOST_CODE, kind: "failed" },
      runId: orphan.run_id,
    });
  }
}
