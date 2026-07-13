/**
 * PostgreSQL-backed Telegram session lifecycle.
 *
 * Exports:
 * - `PreparedSession`: application session selected for an inbound turn.
 * - `SessionRetentionClaim`: exclusive lease for physical Eve storage deletion.
 * - `sessionRepository`: rotation, route, event, and retention operations.
 */
import type { PoolClient } from "pg";

import {
  SESSION_RETENTION_DAYS,
  SESSION_RETENTION_LEASE_MS,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  continuationTokenForGeneration,
  sessionNeedsRotation,
} from "./session-policy.js";
import {
  classifyMissedSessionEvent,
  isCurrentEveSession,
  type SessionEventResult,
} from "./session-eve-event.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export type ConversationSessionScope = "family" | "group" | "personal";

export interface PrepareSessionInput {
  baseContinuationToken: string;
  familyId: string;
  groupId: string | null;
  now: Date;
  scope: ConversationSessionScope;
  userId: string | null;
}

export interface PreparedSession {
  continuationToken: string;
  generation: number;
  id: string;
  rotated: boolean;
}

export interface SessionRetentionClaim {
  eveSessionId: string;
  id: string;
  leaseToken: string;
}

interface SessionRow {
  completed_turns: number;
  continuation_token: string;
  eve_session_id: string | null;
  family_id: string;
  generation: number;
  group_id: string | null;
  id: string;
  last_activity_at: Date;
  owner_user_id: string | null;
  pending_operation: boolean;
  rotation_requested_at: Date | null;
  retired_at: Date | null;
  scope: ConversationSessionScope;
  thread_id: string;
}

function assertSameScope(row: SessionRow, input: PrepareSessionInput): void {
  // A Telegram route is security-sensitive: it may never be rebound across app trust zones.
  if (
    row.family_id !== input.familyId ||
    row.owner_user_id !== input.userId ||
    row.group_id !== input.groupId ||
    row.scope !== input.scope
  ) {
    throw new AppError(
      "AGENT_SESSION_SCOPE_MISMATCH",
      "Контекст Telegram относится к другой области доступа. Начните новый разговор",
    );
  }
}

async function findSessionForUpdate(
  client: PoolClient,
  baseToken: string,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT s.*
       FROM conversation_sessions s
       LEFT JOIN conversation_session_routes r ON r.session_id = s.id
      WHERE r.base_continuation_token = $1
         OR (s.conversation_key = $1 AND s.retired_at IS NULL)
      ORDER BY (s.retired_at IS NULL) DESC, s.generation DESC
      LIMIT 1
      FOR UPDATE OF s`,
    [baseToken],
  );
  return result.rows[0] ?? null;
}

async function createInitialSession(
  client: PoolClient,
  input: PrepareSessionInput,
  generation = 0,
): Promise<SessionRow> {
  const continuationToken = continuationTokenForGeneration(input.baseContinuationToken, generation);
  const result = await client.query<SessionRow>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING *`,
    [
      generation,
      input.familyId,
      input.userId,
      input.groupId,
      input.scope,
      input.baseContinuationToken,
      continuationToken,
      input.now,
    ],
  );
  return result.rows[0]!;
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

  const generation = current.generation + 1;
  const continuationToken = continuationTokenForGeneration(input.baseContinuationToken, generation);
  const result = await client.query<SessionRow>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING *`,
    [
      current.thread_id,
      generation,
      current.family_id,
      current.owner_user_id,
      current.group_id,
      current.scope,
      input.baseContinuationToken,
      continuationToken,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     VALUES ($1, 'session.rotated', $2, jsonb_build_object('generation', $3::integer))`,
    [current.family_id, current.id, generation],
  );
  return result.rows[0]!;
}

async function upsertRoute(client: PoolClient, baseToken: string, sessionId: string): Promise<void> {
  await client.query(
    `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
     VALUES ($1, $2)
     ON CONFLICT (base_continuation_token) DO UPDATE
       SET session_id = EXCLUDED.session_id, updated_at = now()`,
    [baseToken, sessionId],
  );
}

export const sessionRepository = {
  isCurrentEveSession,

  async prepareTurn(input: PrepareSessionInput): Promise<PreparedSession> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Route-level advisory locking covers the first insert before a row lock exists.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.baseContinuationToken],
      );
      let current = await findSessionForUpdate(client, input.baseContinuationToken);
      if (!current) {
        current = await createInitialSession(
          client,
          input,
          await initialGeneration(client, input.baseContinuationToken),
        );
      }
      const trustZoneRecreated = current.retired_at !== null;
      if (trustZoneRecreated) {
        current = await createInitialSession(client, input, current.generation + 1);
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
      await upsertRoute(client, input.baseContinuationToken, current.id);
      await client.query("COMMIT");
      return {
        continuationToken: current.continuation_token,
        generation: current.generation,
        id: current.id,
        rotated: rotate || trustZoneRecreated,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async bindEveSession(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
           SET eve_session_id = $2
         WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_BIND_FAILED",
      "Не удалось связать текущий контекст с Eve",
    );
  },

  async markPendingOperation(id: string, pending: boolean): Promise<void> {
    const result = await database().query(
      "UPDATE conversation_sessions SET pending_operation = $2 WHERE id = $1 AND retired_at IS NULL",
      [id, pending],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
    }
  },

  async recordTurnCompleted(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET completed_turns = completed_turns + 1,
              last_activity_at = now(), pending_operation = false,
              eve_session_id = $2
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_TURN_RECORD_FAILED",
      "Не удалось сохранить завершённый ход",
    );
  },

  async recordTurnFailed(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false, eve_session_id = $2
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_FAILURE_RECORD_FAILED",
      "Не удалось сохранить состояние контекста",
    );
  },

  async recordSessionFailedByContinuationToken(continuationToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false, rotation_requested_at = now()
        WHERE continuation_token = $1 AND retired_at IS NULL`,
      [continuationToken],
    );
    // A pre-rollout session can fail before it has any application lifecycle row.
    if (result.rowCount !== 0 && result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_FAILURE_RECORD_FAILED", "Не удалось завершить повреждённый контекст");
    }
  },

  async requestRotation(id: string): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET rotation_requested_at = now()
        WHERE id = $1 AND retired_at IS NULL`,
      [id],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
    }
  },

  async registerRoute(id: string, baseToken: string): Promise<string> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<Pick<SessionRow, "generation" | "id">>(
        "SELECT id, generation FROM conversation_sessions WHERE id = $1 AND retired_at IS NULL FOR UPDATE",
        [id],
      );
      const row = session.rows[0];
      if (!row) throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
      const token = continuationTokenForGeneration(baseToken, row.generation);
      await client.query(
        "UPDATE conversation_sessions SET continuation_token = $2 WHERE id = $1",
        [id, token],
      );
      await upsertRoute(client, baseToken, id);
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async resolveContinuationToken(baseToken: string): Promise<string> {
    const result = await database().query<{
      continuation_token: string;
      retired_at: Date | null;
    }>(
      `SELECT s.continuation_token, s.retired_at
         FROM conversation_session_routes r
         JOIN conversation_sessions s ON s.id = r.session_id
        WHERE r.base_continuation_token = $1`,
      [baseToken],
    );
    const routed = result.rows[0];
    if (routed?.retired_at) {
      throw new AppError(
        "AGENT_SESSION_CALLBACK_EXPIRED",
        "Кнопка относится к завершённому контексту. Повторите запрос в новом сообщении",
      );
    }
    if (routed) return routed.continuation_token;

    // Rollout compatibility: an approval can be clicked before the old generation-zero session
    // receives its first normal post-deploy message. Numeric Telegram IDs are trusted DB keys.
    const chatId = baseToken.split(":", 1)[0];
    if (!chatId) return baseToken;
    if (chatId.startsWith("-")) {
      const group = await database().query<{
        family_id: string;
        id: string;
        type: "external_private" | "external_public" | "family_private";
      }>(
        "SELECT id, family_id, type FROM telegram_groups WHERE telegram_chat_id = $1",
        [chatId],
      );
      const row = group.rows[0];
      if (!row) return baseToken;
      const prepared = await this.prepareTurn({
        baseContinuationToken: baseToken,
        familyId: row.family_id,
        groupId: row.id,
        now: new Date(),
        scope: row.type === "family_private" ? "family" : "group",
        userId: null,
      });
      return prepared.continuationToken;
    }
    const identity = await database().query<{ family_id: string; user_id: string }>(
      `SELECT fm.family_id, u.id AS user_id
         FROM users u JOIN family_memberships fm ON fm.user_id = u.id
        WHERE u.telegram_user_id = $1`,
      [chatId],
    );
    const row = identity.rows[0];
    if (!row) return baseToken;
    const prepared = await this.prepareTurn({
      baseContinuationToken: baseToken,
      familyId: row.family_id,
      groupId: null,
      now: new Date(),
      scope: "personal",
      userId: row.user_id,
    });
    return prepared.continuationToken;
  },

  async findIdByContinuationToken(continuationToken: string): Promise<string | null> {
    const result = await database().query<{ id: string }>(
      `SELECT id FROM conversation_sessions
        WHERE continuation_token = $1 AND retired_at IS NULL`,
      [continuationToken],
    );
    return result.rows[0]?.id ?? null;
  },

  async claimExpiredForDeletion(now: Date): Promise<SessionRetentionClaim | null> {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + SESSION_RETENTION_LEASE_MS);
    const result = await database().query<{
      eve_session_id: string;
      id: string;
      retention_lease_token: string;
    }>(
      `UPDATE conversation_sessions
          SET retention_lease_token = $2, retention_lease_expires_at = $3
        WHERE id = (
          SELECT id FROM conversation_sessions
           WHERE retired_at IS NOT NULL AND delete_after <= $1
             AND retention_hold = false AND eve_session_id IS NOT NULL
             AND (retention_lease_expires_at IS NULL OR retention_lease_expires_at <= $1)
           ORDER BY delete_after, id
           LIMIT 1 FOR UPDATE SKIP LOCKED
        )
      RETURNING id, eve_session_id, retention_lease_token`,
      [now, leaseToken, leaseExpiresAt],
    );
    const row = result.rows[0];
    return row
      ? { eveSessionId: row.eve_session_id, id: row.id, leaseToken: row.retention_lease_token }
      : null;
  },

  async completeDeletion(id: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      "DELETE FROM conversation_sessions WHERE id = $1 AND retention_lease_token = $2",
      [id, leaseToken],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_RETENTION_LEASE_LOST", "Не удалось подтвердить удаление контекста");
    }
  },

  async failDeletion(id: string, leaseToken: string, errorCode: string): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET cleanup_error_code = $3,
              retention_lease_token = NULL,
              retention_lease_expires_at = NULL
        WHERE id = $1 AND retention_lease_token = $2`,
      [id, leaseToken, errorCode],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_RETENTION_LEASE_LOST", "Не удалось сохранить ошибку удаления контекста");
    }
  },
};
