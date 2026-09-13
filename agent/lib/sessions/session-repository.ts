/**
 * PostgreSQL-backed Telegram session lifecycle.
 *
 * Exports:
 * - `PreparedSession`: application session selected for an inbound turn.
 * - Session role and park input types used by channel lifecycle boundaries.
 * - `sessionRepository`: canonical/task/review preparation, rotation, routes, events, and retention.
 */
import type { PoolClient } from "pg";

import {
  SESSION_GROUP_ROTATION_LOCK_HASH_SEED,
  SESSION_RETENTION_DAYS,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  continuationTokenForGeneration,
  sessionNeedsRotation,
} from "./session-policy.js";
import {
  sessionRouteRepository,
  upsertSessionRoute,
} from "./session-route-repository.js";
import {
  isCurrentEveSession,
} from "./session-eve-event.js";
import { sessionLifecycleEventRepository } from "./session-lifecycle-event-repository.js";
import { sessionRetentionRepository } from "./session-retention-repository.js";
import { sessionTaskCleanupRepository } from "./session-task-cleanup-repository.js";
import { prepareAuthorizedResponse } from "./session-response-preparation.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export type ConversationSessionScope = "family" | "group" | "personal";
export type ConversationSessionKind = "canonical" | "proactive" | "scheduled" | "task";

export interface PrepareSessionInput {
  baseContinuationToken: string;
  familyId: string;
  groupId: string | null;
  kind: Exclude<ConversationSessionKind, "proactive">;
  now: Date;
  scope: ConversationSessionScope;
  telegramForumTopicId: number | null;
  userId: string | null;
}

export interface PreparedSession {
  continuationToken: string;
  generation: number;
  id: string;
  /** True when rotation, task promotion, or trust-zone recreation requires a fresh Eve generation. */
  rotated: boolean;
  sandboxSessionId: string;
}

export interface ParkSessionInput {
  applicationSessionId: string;
  pendingRequestId: string | null;
  requesterTelegramUserId: string | null;
  requesterUserId: string | null;
}

interface SessionRow {
  completed_turns: number;
  continuation_token: string;
  eve_session_id: string | null;
  family_id: string;
  generation: number;
  group_id: string | null;
  id: string;
  kind: ConversationSessionKind;
  last_activity_at: Date;
  owner_user_id: string | null;
  pending_operation: boolean;
  rotation_requested_at: Date | null;
  retired_at: Date | null;
  scope: ConversationSessionScope;
  task_state: "completed" | "failed" | "pending" | "running" | null;
  telegram_forum_topic_id: string | null;
  thread_id: string;
}

function assertSameScope(row: SessionRow, input: PrepareSessionInput): void {
  // A Telegram route is security-sensitive: it may never be rebound across app trust zones.
  if (
    row.family_id !== input.familyId ||
    row.owner_user_id !== input.userId ||
    row.group_id !== input.groupId ||
    row.scope !== input.scope ||
    row.kind !== input.kind ||
    (input.kind === "canonical" && row.telegram_forum_topic_id !== (
      input.telegramForumTopicId === null ? null : String(input.telegramForumTopicId)
    ))
  ) {
    throw new AppError(
      "AGENT_SESSION_SCOPE_MISMATCH",
      "Контекст Telegram относится к другой области доступа. Начните новый разговор",
    );
  }
}

async function findSessionForUpdate(
  client: PoolClient,
  input: PrepareSessionInput,
): Promise<SessionRow | null> {
  if (input.kind === "task") {
    const task = await client.query<SessionRow>(
      `SELECT s.*
         FROM conversation_sessions s
         JOIN conversation_session_routes r ON r.session_id = s.id
        WHERE r.base_continuation_token = $1
          AND s.kind = 'task' AND s.task_state = 'pending' AND s.retired_at IS NULL
        LIMIT 1
        FOR UPDATE OF s`,
      [input.baseContinuationToken],
    );
    return task.rows[0] ?? null;
  }
  const result = await client.query<SessionRow>(
    `SELECT s.*
       FROM conversation_sessions s
       LEFT JOIN conversation_session_routes r ON r.session_id = s.id
      WHERE s.kind = $2
        AND (r.base_continuation_token = $1
          OR (s.conversation_key = $1 AND s.retired_at IS NULL))
      ORDER BY (s.retired_at IS NULL) DESC, s.generation DESC
      LIMIT 1
      FOR UPDATE OF s`,
    [input.baseContinuationToken, input.kind],
  );
  return result.rows[0] ?? null;
}

async function createInitialSession(
  client: PoolClient,
  input: PrepareSessionInput,
  generation = 0,
  threadId: string = crypto.randomUUID(),
): Promise<SessionRow> {
  const continuationToken = continuationTokenForGeneration(input.baseContinuationToken, generation);
  const result = await client.query<SessionRow>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
         telegram_forum_topic_id, conversation_key, continuation_token, started_at, last_activity_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING *`,
    [
      threadId,
      generation,
      input.familyId,
      input.userId,
      input.groupId,
      input.scope,
      input.kind,
      input.kind === "canonical" ? null : "running",
      input.telegramForumTopicId,
      input.baseContinuationToken,
      continuationToken,
      input.now,
    ],
  );
  return result.rows[0]!;
}

async function canonicalReplacementSeed(
  client: PoolClient,
  input: PrepareSessionInput,
): Promise<{ threadId: string } | null> {
  if (input.kind !== "canonical" || input.groupId === null) return null;
  const result = await client.query<{ thread_id: string }>(
    `SELECT thread_id
       FROM conversation_sessions
      WHERE group_id = $1
        AND telegram_forum_topic_id IS NOT DISTINCT FROM $2
      ORDER BY (kind = 'task' AND retired_at IS NULL) DESC, generation DESC, started_at DESC
      LIMIT 1
      FOR UPDATE`,
    [input.groupId, input.telegramForumTopicId],
  );
  const row = result.rows[0];
  return row ? { threadId: row.thread_id } : null;
}

async function nextThreadGeneration(client: PoolClient, threadId: string): Promise<number> {
  // Lifecycle selection may intentionally prefer an older active task, but generation remains
  // monotonic across the complete thread history, including retired rows.
  const result = await client.query<{ next_generation: number | null }>(
    `SELECT max(generation) + 1 AS next_generation
       FROM conversation_sessions
      WHERE thread_id = $1`,
    [threadId],
  );
  const generation = result.rows[0]?.next_generation;
  if (generation === null || generation === undefined) {
    throw new AppError(
      "AGENT_SESSION_GENERATION_INVALID",
      "Не удалось определить следующую версию контекста",
    );
  }
  return generation;
}

async function initialGeneration(client: PoolClient, baseToken: string): Promise<number> {
  const routeOwner = baseToken.split(":", 1)[0];
  const result = await client.query<{ next_generation: number }>(
    "SELECT next_generation FROM conversation_route_generations WHERE route_owner = $1",
    [routeOwner],
  );
  return result.rows[0]?.next_generation ?? 0;
}

async function rotateSession(
  client: PoolClient,
  current: SessionRow,
  input: PrepareSessionInput,
): Promise<SessionRow> {
  const deleteAfter = new Date(input.now.getTime() + SESSION_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  await client.query(
    `UPDATE conversation_sessions
        SET retired_at = $2, delete_after = $3, pending_operation = false
      WHERE id = $1`,
    [current.id, input.now, deleteAfter],
  );

  const generation = await nextThreadGeneration(client, current.thread_id);
  const continuationToken = continuationTokenForGeneration(input.baseContinuationToken, generation);
  const result = await client.query<SessionRow>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
         telegram_forum_topic_id, conversation_key, continuation_token, started_at, last_activity_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING *`,
    [
      current.thread_id,
      generation,
      current.family_id,
      current.owner_user_id,
      current.group_id,
      current.scope,
      current.kind,
      current.kind === "canonical" ? null : "running",
      current.telegram_forum_topic_id,
      input.baseContinuationToken,
      continuationToken,
      input.now,
    ],
  );
  const replacement = result.rows[0]!;

  // Every delivered Telegram anchor follows the logical conversation across generations. Moving
  // aliases in the same transaction prevents replies from selecting an already retired row.
  await client.query(
    "UPDATE conversation_session_routes SET session_id = $2, updated_at = now() WHERE session_id = $1",
    [current.id, replacement.id],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     VALUES ($1, 'session.rotated', $2, jsonb_build_object('generation', $3::integer))`,
    [current.family_id, current.id, generation],
  );
  return replacement;
}

export const sessionRepository = {
  prepareAuthorizedResponse,
  ...sessionRouteRepository,
  ...sessionLifecycleEventRepository,
  ...sessionRetentionRepository,
  ...sessionTaskCleanupRepository,
  isCurrentEveSession,

  async prepareTurn(input: PrepareSessionInput): Promise<PreparedSession> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Group-wide rotation and per-topic preparation share this short transaction lock, so an
      // owner request cannot miss a canonical generation concurrently replacing another one.
      if (input.groupId !== null) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
          [input.groupId, SESSION_GROUP_ROTATION_LOCK_HASH_SEED],
        );
      }
      // Route-level advisory locking covers the first insert before a row lock exists.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.baseContinuationToken],
      );
      let current = await findSessionForUpdate(client, input);
      let trustZoneRecreated = false;
      if (!current) {
        if (input.kind === "task") {
          throw new AppError(
            "AGENT_TASK_ROUTE_NOT_PENDING",
            "Запрошенное действие уже завершено или больше не ожидает ответа",
          );
        }
        const replacement = await canonicalReplacementSeed(client, input);
        const generation = replacement
          ? await nextThreadGeneration(client, replacement.threadId)
          : await initialGeneration(client, input.baseContinuationToken);
        current = await createInitialSession(client, input, generation, replacement?.threadId);
        if (replacement) {
          await client.query(
            `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
             VALUES ($1, 'session.canonical_replaced', $2,
                     jsonb_build_object('generation', $3::integer))`,
            [current.family_id, current.id, current.generation],
          );
        }
        // A non-zero ledger entry exists only after the previous Telegram trust zone was retired.
        trustZoneRecreated = generation > 0;
      }
      if (current.retired_at !== null) {
        trustZoneRecreated = true;
        current = await createInitialSession(
          client,
          input,
          await nextThreadGeneration(client, current.thread_id),
        );
      }
      assertSameScope(current, input);

      const rotate = !trustZoneRecreated && sessionNeedsRotation({
        completedTurns: current.completed_turns,
        lastActivityAt: current.last_activity_at,
        now: input.now,
        pendingOperation: current.pending_operation,
        rotationRequestedAt: current.rotation_requested_at,
      });
      if (rotate) current = await rotateSession(client, current, input);
      await upsertSessionRoute(client, input.baseContinuationToken, current.id);
      await client.query("COMMIT");
      return {
        continuationToken: current.continuation_token,
        generation: current.generation,
        id: current.id,
        rotated: rotate || trustZoneRecreated,
        sandboxSessionId: current.thread_id,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async parkSession(input: ParkSessionInput): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ group_id: string | null; kind: ConversationSessionKind }>(
        `SELECT group_id, kind FROM conversation_sessions
          WHERE id = $1 AND retired_at IS NULL
          FOR UPDATE`,
        [input.applicationSessionId],
      );
      const session = result.rows[0];
      if (!session) {
        throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
      }

      // Only an observable park reclassifies a group canonical. Personal sessions retain their
      // existing conversation lifecycle; scheduled/proactive sessions retain their explicit kind.
      const promote = session.kind === "canonical" && session.group_id !== null;
      await client.query(
        `UPDATE conversation_sessions
            SET kind = CASE WHEN $2 THEN 'task'::conversation_session_kind ELSE kind END,
                task_state = CASE
                  WHEN $2 OR kind <> 'canonical' THEN 'pending'::conversation_task_state
                  ELSE task_state
                END,
                pending_operation = true,
                requester_user_id = coalesce($3, requester_user_id),
                requester_telegram_user_id = coalesce($4, requester_telegram_user_id),
                pending_request_id = coalesce($5, pending_request_id),
                originating_canonical_session_id = CASE WHEN $2 THEN id ELSE originating_canonical_session_id END
          WHERE id = $1`,
        [
          input.applicationSessionId,
          promote,
          input.requesterUserId,
          input.requesterTelegramUserId,
          input.pendingRequestId,
        ],
      );
      if (promote) {
        // Ordinary delivery aliases must not make the parked workflow selectable. The exact prompt
        // alias is registered only after Telegram returns its durable message ID.
        await client.query("DELETE FROM conversation_session_routes WHERE session_id = $1", [
          input.applicationSessionId,
        ]);
        await client.query(
          `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
           SELECT family_id, 'session.promoted_to_task', id,
                  jsonb_build_object('pendingRequestId', $2::text)
             FROM conversation_sessions WHERE id = $1`,
          [input.applicationSessionId, input.pendingRequestId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

};
