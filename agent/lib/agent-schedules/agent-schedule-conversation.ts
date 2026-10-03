/**
 * Binding of schedules that run inside the conversation that created them.
 *
 * Exports:
 * - `ConversationBinding`: the conversation and chat queue a conversation run belongs to.
 * - `requireExecutionContext`: validates where a new schedule runs.
 * - `requireConversationRunLimit`: every conversation schedule has a bounded number of runs.
 * - `requireConversationBinding`: resolves the binding from the verified current turn.
 * - `requireConversationCapacity`: bounds active conversation schedules per chat queue.
 * - `rebindConversationSchedule`: moves a resumed schedule to the conversation it is resumed from.
 * - `isConversationWakeupIdle`: whether a leased conversation schedule has no turn in progress.
 *
 * A conversation run is a turn in the chat's own session, delivered through the chat's own queue.
 * Both are taken from the turn that asks for it, never from the model.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { AGENT_SCHEDULE_CONVERSATION_MAX_ACTIVE, AGENT_SCHEDULE_CONVERSATION_MAX_RUNS } from "./agent-schedule-config.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import type { AgentScheduleExecutionContext, AgentScheduleScope } from "./agent-schedule-record.js";

export interface ConversationBinding {
  conversationSessionId: string;
  ingressQueueId: string;
}

export function requireExecutionContext(value: unknown): AgentScheduleExecutionContext {
  if (value !== "conversation" && value !== "isolated") {
    throw new AppError(
      "AGENT_SCHEDULE_INPUT_INVALID",
      "Поле executionContext должно быть conversation (в этом разговоре) или isolated (отдельно)",
    );
  }
  return value;
}

export function requireConversationRunLimit(maxRuns: number | null | undefined): void {
  if (maxRuns === undefined || maxRuns === null) {
    throw new AppError(
      "AGENT_SCHEDULE_CONVERSATION_LIMIT_REQUIRED",
      "Для пробуждения в разговоре укажите maxRuns: каждое пробуждение — полный вызов модели со всей историей чата",
    );
  }
  if (maxRuns > AGENT_SCHEDULE_CONVERSATION_MAX_RUNS) {
    throw new AppError(
      "AGENT_SCHEDULE_CONVERSATION_LIMIT_TOO_HIGH",
      `Пробуждение в разговоре выполняется не больше ${AGENT_SCHEDULE_CONVERSATION_MAX_RUNS} раз. Уменьшите maxRuns или используйте сценарий отдельно`,
    );
  }
}

function unavailable(): never {
  throw new AppError(
    "AGENT_SCHEDULE_CONVERSATION_UNAVAILABLE",
    "Пробуждение в разговоре можно поставить только в ответ на сообщение в этом чате. Используйте сценарий отдельно",
  );
}

export async function requireConversationBinding(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
): Promise<ConversationBinding> {
  if (auth.applicationSessionId === undefined || auth.telegramUpdateId === undefined) unavailable();
  const result = await client.query<{ queue_id: string }>(
    `SELECT update_row.queue_id::text
       FROM telegram_ingress_updates update_row
       JOIN conversation_sessions session ON session.id = $2::uuid
      WHERE update_row.update_id = $1::bigint
        AND session.family_id = $3 AND session.retired_at IS NULL AND session.kind = 'canonical'`,
    [auth.telegramUpdateId, auth.applicationSessionId, auth.familyId],
  );
  const queueId = result.rows[0]?.queue_id;
  if (!queueId) unavailable();
  return { conversationSessionId: auth.applicationSessionId!, ingressQueueId: queueId };
}

export async function requireConversationCapacity(
  client: PoolClient,
  familyId: string,
  ingressQueueId: string,
  excludeScheduleId: string | null,
): Promise<void> {
  // Concurrent creations in one chat serialize on the queue row they all bind to.
  await client.query("SELECT 1 FROM telegram_ingress_queues WHERE id = $1 FOR UPDATE", [ingressQueueId]);
  const result = await client.query<{ active: number }>(
    `SELECT count(*)::int AS active FROM agent_schedules
      WHERE family_id = $1 AND ingress_queue_id = $2 AND execution_context = 'conversation'
        AND status IN ('active', 'leased') AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [familyId, ingressQueueId, excludeScheduleId],
  );
  if ((result.rows[0]?.active ?? 0) >= AGENT_SCHEDULE_CONVERSATION_MAX_ACTIVE) {
    throw new AppError(
      "AGENT_SCHEDULE_CONVERSATION_LIMIT_REACHED",
      `В этом чате уже ${AGENT_SCHEDULE_CONVERSATION_MAX_ACTIVE} активных пробуждения. Отмените одно из них или дождитесь его завершения`,
    );
  }
}

/** A resumed wake-up continues in the conversation the person resumes it from, in the same chat. */
export async function rebindConversationSchedule(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  schedule: { id: string; message_thread_id: string | null; scope: AgentScheduleScope; telegram_chat_id: string },
): Promise<void> {
  // A personal schedule is stored without a thread, exactly as it was created.
  const currentThread = schedule.scope === "personal" ? null : auth.messageThreadId;
  if (auth.telegramChatId !== schedule.telegram_chat_id || currentThread !== schedule.message_thread_id) {
    throw new AppError(
      "AGENT_SCHEDULE_CONVERSATION_CHAT_MISMATCH",
      "Возобновить пробуждение можно только в том чате, где оно поставлено",
    );
  }
  const binding = await requireConversationBinding(client, auth);
  await requireConversationCapacity(client, auth.familyId, binding.ingressQueueId, schedule.id);
  await client.query(
    "UPDATE agent_schedules SET conversation_session_id = $2, ingress_queue_id = $3 WHERE id = $1",
    [schedule.id, binding.conversationSessionId, binding.ingressQueueId],
  );
}

/**
 * True when the current occurrence's queue item exists and no turn is being prepared or run for it:
 * it still waits in the queue, or it already ended while its run waits for a turn that may never
 * report. A locked item belongs to a processor that is about to start its turn.
 */
export async function isConversationWakeupIdle(client: PoolClient, scheduleId: string): Promise<boolean> {
  const result = await client.query<{ status: string }>(
    `SELECT wakeup.status
       FROM agent_schedules schedule
       JOIN agent_schedule_runs run ON run.schedule_id = schedule.id AND run.lease_token = schedule.lease_token
       JOIN telegram_ingress_wakeups wakeup ON wakeup.run_id = run.id
      WHERE schedule.id = $1 AND schedule.execution_context = 'conversation'
      FOR UPDATE OF wakeup SKIP LOCKED`,
    [scheduleId],
  );
  const status = result.rows[0]?.status;
  return status !== undefined && status !== "processing";
}
