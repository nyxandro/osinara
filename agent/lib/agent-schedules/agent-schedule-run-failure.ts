/**
 * Terminal failure transitions for active scheduled agent runs.
 *
 * Exports:
 * - `failAgentScheduleRun`: closes a run when no failure notification is needed.
 * - `failAgentScheduleRunForNotification`: closes a known turn and returns live delivery permission.
 * - `failAgentScheduleRunByIdentityForNotification`: closes a terminal Eve session by run identity.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import {
  type AgentScheduleDeliveryAuthorizationInput,
  isAgentScheduleDeliveryAuthorized,
} from "./agent-schedule-delivery-authorization.js";
import type { AgentScheduleScope } from "./agent-schedule-record.js";
import { finishActiveAgentScheduleRun } from "./agent-schedule-run-completion.js";

interface AuthorizationRow {
  application_session_id: string;
  family_id: string;
  group_id: string | null;
  message_thread_id: string | null;
  owner_user_id: string | null;
  scope: AgentScheduleScope;
  telegram_chat_id: string;
}

async function loadAuthorization(
  client: PoolClient,
  runId: string,
  eveSessionId: string,
): Promise<AgentScheduleDeliveryAuthorizationInput | null> {
  const result = await client.query<AuthorizationRow>(
    `SELECT run.application_session_id::text, schedule.family_id,
            schedule.group_id, schedule.message_thread_id::text,
            schedule.owner_user_id, schedule.scope, schedule.telegram_chat_id
       FROM agent_schedule_runs AS run
       JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
      WHERE run.id = $1
        AND (run.eve_session_id = $2 OR
          (run.status = 'dispatching' AND run.eve_session_id IS NULL))
        AND run.application_session_id IS NOT NULL
        AND run.status IN ('dispatching', 'running') AND schedule.status = 'leased'
      FOR UPDATE OF run, schedule`,
    [runId, eveSessionId],
  );
  const row = result.rows[0];
  return row
    ? {
        applicationSessionId: row.application_session_id,
        eveSessionId,
        familyId: row.family_id,
        groupId: row.group_id,
        messageThreadId: row.message_thread_id,
        ownerUserId: row.owner_user_id,
        runId,
        scope: row.scope,
        telegramChatId: row.telegram_chat_id,
      }
    : null;
}

async function failWithinTransaction(
  client: PoolClient,
  authorization: AgentScheduleDeliveryAuthorizationInput,
  errorCode: string,
  failedAt: Date,
  authorizeNotification: boolean,
): Promise<{ failed: boolean; notify: boolean }> {
  const notify = authorizeNotification &&
    await isAgentScheduleDeliveryAuthorized(client, authorization);
  const failed = await finishActiveAgentScheduleRun(client, {
    applicationSessionId: authorization.applicationSessionId,
    completedAt: failedAt,
    eveSessionId: authorization.eveSessionId,
    outcome: { errorCode, kind: "failed" },
  });
  return { failed, notify: failed && notify };
}

export async function failAgentScheduleRun(
  applicationSessionId: string,
  eveSessionId: string,
  errorCode: string,
  failedAt: Date,
): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const failed = await finishActiveAgentScheduleRun(client, {
      applicationSessionId,
      completedAt: failedAt,
      eveSessionId,
      outcome: { errorCode, kind: "failed" },
    });
    await client.query("COMMIT");
    return failed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failAgentScheduleRunForNotification(
  authorization: AgentScheduleDeliveryAuthorizationInput,
  errorCode: string,
  failedAt: Date,
): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await failWithinTransaction(client, authorization, errorCode, failedAt, true);
    await client.query("COMMIT");
    return result.notify;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failAgentScheduleRunByIdentityForNotification(
  runId: string,
  eveSessionId: string,
  errorCode: string,
  failedAt: Date,
): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const authorization = await loadAuthorization(client, runId, eveSessionId);
    if (!authorization) {
      await client.query("COMMIT");
      return false;
    }
    // A terminal Eve event may beat the dispatcher's post-receive running marker.
    await client.query(
      `UPDATE agent_schedule_runs
          SET status = 'running', eve_session_id = $2, updated_at = $3
        WHERE id = $1 AND status = 'dispatching' AND eve_session_id IS NULL`,
      [runId, eveSessionId, failedAt],
    );
    const result = await failWithinTransaction(client, authorization, errorCode, failedAt, true);
    await client.query("COMMIT");
    return result.notify;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
