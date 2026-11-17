/**
 * A background task as the application sees it, and the plumbing its repositories share.
 *
 * Exports:
 * - `BackgroundTask`, `BackgroundTaskState`, `BackgroundTaskOutcomeState`, `BackgroundTaskChat`: the record.
 * - `BACKGROUND_TASK_ACTIVE_STATES`: the states in which a task still holds work or a question.
 * - `TaskRow`, `mapTask`: the stored row and its reading.
 * - `activeMsAt`: working time at a moment, the run under way included.
 * - `inTransaction`: one transaction on a pooled connection.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";

export type BackgroundTaskOutcomeState = "failed" | "finished" | "limit_steps" | "limit_time" | "stopped" | "unanswered";
export type BackgroundTaskState = BackgroundTaskOutcomeState | "queued" | "reported" | "running" | "stopping" | "waiting_answer";

export type BackgroundTaskSummaryReason = "limit_steps" | "limit_time" | "stopped";

export const BACKGROUND_TASK_ACTIVE_STATES = ["queued", "running", "waiting_answer", "stopping"] as const;

/** Where a task lives: a task is seen and managed only from its own chat and topic. */
export interface BackgroundTaskChat {
  readonly forumTopicId: string | null;
  readonly telegramChatId: string;
}

export interface BackgroundTask extends BackgroundTaskChat {
  readonly activeMs: number;
  readonly agentSessionId: string | null;
  readonly applicationSessionId: string | null;
  readonly authorUserId: string;
  readonly createdAt: Date;
  readonly currentTurnId: string | null;
  readonly familyId: string;
  readonly finishedAt: Date | null;
  readonly groupId: string | null;
  readonly id: string;
  readonly ingressQueueId: string | null;
  readonly lastStepAt: Date | null;
  readonly messageThreadId: string | null;
  readonly note: string | null;
  readonly outcomeCode: string | null;
  readonly outcomeFiles: readonly string[];
  readonly outcomeText: string | null;
  readonly questionSeq: number;
  readonly reportedAt: Date | null;
  readonly runningSince: Date | null;
  readonly sandboxSessionId: string;
  readonly state: BackgroundTaskState;
  readonly steps: number;
  readonly stopRequestedAt: Date | null;
  /** Set before the summary turn of a cut-off task, so a restart ends it with the same reason. */
  readonly summaryReason: BackgroundTaskSummaryReason | null;
  readonly task: string;
  readonly telegramChatType: "group" | "private" | "supergroup";
  readonly title: string;
  readonly waitingQuestion: string | null;
  readonly waitingSince: Date | null;
}

export interface TaskRow {
  active_ms: string; agent_session_id: string | null; application_session_id: string | null; author_user_id: string;
  created_at: Date; current_turn_id: string | null; family_id: string; finished_at: Date | null; forum_topic_id: string | null;
  group_id: string | null; id: string; ingress_queue_id: string | null; last_step_at: Date | null; message_thread_id: string | null; note: string | null;
  outcome_code: string | null; outcome_files: string[] | null; outcome_text: string | null; question_seq: number;
  reported_at: Date | null; running_since: Date | null; sandbox_session_id: string; state: BackgroundTaskState; steps: number;
  stop_requested_at: Date | null; summary_reason: BackgroundTaskSummaryReason | null; task: string; telegram_chat_id: string; telegram_chat_type: BackgroundTask["telegramChatType"];
  title: string; waiting_question: string | null; waiting_since: Date | null;
}

export function mapTask(row: TaskRow): BackgroundTask {
  return {
    activeMs: Number(row.active_ms), agentSessionId: row.agent_session_id, applicationSessionId: row.application_session_id,
    authorUserId: row.author_user_id, createdAt: row.created_at, currentTurnId: row.current_turn_id, familyId: row.family_id,
    finishedAt: row.finished_at, forumTopicId: row.forum_topic_id, groupId: row.group_id, id: row.id, ingressQueueId: row.ingress_queue_id,
    lastStepAt: row.last_step_at, messageThreadId: row.message_thread_id, note: row.note, outcomeCode: row.outcome_code,
    outcomeFiles: row.outcome_files ?? [], outcomeText: row.outcome_text, questionSeq: row.question_seq,
    reportedAt: row.reported_at, runningSince: row.running_since, sandboxSessionId: row.sandbox_session_id, state: row.state,
    steps: row.steps, stopRequestedAt: row.stop_requested_at, summaryReason: row.summary_reason, task: row.task, telegramChatId: row.telegram_chat_id,
    telegramChatType: row.telegram_chat_type, title: row.title, waitingQuestion: row.waiting_question,
    waitingSince: row.waiting_since,
  };
}

export function isActiveState(state: BackgroundTaskState): boolean {
  return (BACKGROUND_TASK_ACTIVE_STATES as readonly string[]).includes(state);
}

/** Working time at `now`: the stored part plus the run under way. */
export function activeMsAt(current: Pick<BackgroundTask, "activeMs" | "runningSince">, now: Date): number {
  return current.activeMs + (current.runningSince === null ? 0 : Math.max(0, now.getTime() - current.runningSince.getTime()));
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
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
