/** An occurrence may be retried only before its exact run acquires the pre-model fence. */
import type { PoolClient } from "pg";
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { database } from "../database.js";
import { AppError } from "../app-error.js";
import { AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS } from "./agent-schedule-config.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";

export async function admitScheduledAgentTurn(input: { runId: string; applicationSessionId: string; eveSessionId: string; eveTurnId: string }): Promise<void> {
  const result = await database().query(`UPDATE agent_schedule_runs run SET status='running',eve_session_id=$3,eve_turn_id=$4,updated_at=now()
    FROM agent_schedules schedule,conversation_sessions session
    WHERE run.id=$1 AND run.application_session_id=$2 AND run.status IN ('dispatching','running')
      AND schedule.id=run.schedule_id AND schedule.status='leased' AND schedule.lease_token=run.lease_token
      AND session.id=$2 AND session.retired_at IS NULL
      AND (run.eve_session_id IS NULL OR run.eve_session_id=$3)
      AND (run.eve_turn_id IS NULL OR run.eve_turn_id=$4) RETURNING run.id`,
  [input.runId, input.applicationSessionId, input.eveSessionId, input.eveTurnId]);
  if (result.rowCount !== 1) throw new AppError("AGENT_SCHEDULE_ATTEMPT_STALE", "Попытка запуска расписания уже закрыта");
}

export async function recoverUnstartedAgentSchedules(client: PoolClient, now: Date): Promise<void> {
  const candidates = await client.query<{ id: string; schedule_id: string; application_session_id: string; attempts: number }>(`SELECT run.id,run.schedule_id,run.application_session_id,schedule.attempts
    FROM agent_schedule_runs run JOIN agent_schedules schedule ON schedule.id=run.schedule_id
    WHERE run.recovery_protocol=1 AND run.status IN ('dispatching','running') AND run.eve_turn_id IS NULL
      AND schedule.status='leased' AND schedule.lease_token=run.lease_token AND schedule.lease_expires_at<=$1
    ORDER BY run.created_at,run.id FOR UPDATE OF run,schedule SKIP LOCKED LIMIT 10`, [now]);
  for (const run of candidates.rows) {
    if (run.attempts>=AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS) {
      await client.query(`UPDATE agent_schedule_runs SET status='failed',error_code='AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED',completed_at=$2,updated_at=$2 WHERE id=$1`, [run.id,now]);
      await client.query(`UPDATE agent_schedules SET status='failed',last_error_code='AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED',
        lease_token=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,updated_at=$2 WHERE id=$1`, [run.schedule_id,now]);
      await recordOperationalIncident({ key: `schedule-run:${run.id}`,code: "AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED",
        summary: "Не удалось запустить расписание после восстановления. Запуск остановлен; требуется проверка владельца.",
        context: { scheduleId: run.schedule_id,runId: run.id } }, client);
      await client.query(`UPDATE conversation_sessions SET retired_at=$2,delete_after=$2::timestamptz+$3*interval '1 day',
        pending_operation=false,task_state='failed' WHERE id=$1`, [run.application_session_id,now,SESSION_RETENTION_DAYS]);
      await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id=$1", [run.id]);
      continue;
    }
    await client.query(`UPDATE agent_schedule_runs SET status='claimed',error_code=NULL,application_session_id=NULL,
      eve_session_id=NULL,eve_turn_id=NULL,dispatch_started_at=NULL,completed_at=NULL,updated_at=$2 WHERE id=$1`, [run.id, now]);
    await client.query(`UPDATE conversation_sessions SET retired_at=$2,delete_after=$2::timestamptz+$3*interval '1 day',
      pending_operation=false,task_state='failed' WHERE id=$1`, [run.application_session_id, now, SESSION_RETENTION_DAYS]);
    await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id=$1", [run.id]);
    await client.query(`UPDATE agent_schedules SET status='active',lease_token=NULL,lease_expires_at=NULL,
      dispatch_started_at=NULL,updated_at=$2 WHERE id=$1`, [run.schedule_id, now]);
    await client.query(`INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
      SELECT family_id,'agent_schedule.handoff_recovered',id,jsonb_build_object('runId',$2::text,'revokedSessionId',$3::text)
      FROM agent_schedules WHERE id=$1`, [run.schedule_id, run.id, run.application_session_id]);
  }
}
