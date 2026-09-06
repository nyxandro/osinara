/**
 * Explicit authoritative memory-thread completion and reactivation boundary.
 *
 * Exports:
 * - Completion authority/turn contracts.
 * - `memoryThreadLifecycleRepository`: replay-safe completion episodes and explicit reactivation.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryOperationHash } from "./memory-record.js";
import { THREAD_ENTRY_REF_PATTERN, THREAD_REF_PATTERN } from "./memory-thread-query-repository.js";

interface VerifiedTurnAuthority {
  conversationId: string;
  timelineEntryId: string;
}

type CompletionAuthority =
  | { kind: "confirmed_outcome"; outcomeRef: string }
  | { kind: "current_user_statement" }
  | { kind: "formal_goal_condition"; outcomeRef: string };

interface ThreadIdentityRow {
  family_id: string;
  id: string;
  memory_project_id: string | null;
  parent_thread_id: string | null;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  status: "active" | "completed";
  subject_conversation_id: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
  thread_ref: string;
}

interface SourceEntryRow {
  entry_ref: string;
  role: "decision" | "episode" | "goal" | "lesson" | "method" | "open_loop" | "outcome";
  source_claim_id: string;
}

// HITL confirms intent to run the tool, but the verified source sentence must still prove completion.
const COMPLETION_SIGNAL_PATTERN = /(?:^|[\s,.;:!?])(?:заверш(?:ён|ена|ено|ены|ен|ила|или|ил)|закончил(?:а|и)?|выполнен(?:а|о|ы)?|сделан(?:а|о|ы)?|готов(?:а|о|ы)?|completed|done|finished)(?=$|[\s,.;:!?])/iu;
const NEGATED_COMPLETION_PATTERN = /(?:^|[\s,.;:!?])(?:не|ещ[её]\s+не|not|is\s+not)\s+(?:заверш|закончил|закончен|выполнен|сделан|готов|completed|done|finished)/iu;

function requireExplicitCompletionStatement(content: string): void {
  if (content.includes("?") || NEGATED_COMPLETION_PATTERN.test(content) ||
    !COMPLETION_SIGNAL_PATTERN.test(content)) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_COMPLETION_NOT_PROVEN",
      "Текущее сообщение не содержит явного подтверждения завершения этой нити",
    );
  }
}

function authorizedPredicate(alias: string): string {
  return `(
    (${alias}.scope = 'personal' AND 'personal' = ANY($3::memory_scope[])
      AND ${alias}.scope_partition_key = $4) OR
    (${alias}.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
    (${alias}.scope = 'group' AND 'group' = ANY($3::memory_scope[])
      AND ${alias}.scope_partition_key = $5)
  )`;
}

async function requireCurrentAccess(client: PoolClient, auth: MemoryAuthorization): Promise<void> {
  if (auth.scopes.includes("group")) {
    const group = await client.query(
      "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 FOR SHARE",
      [auth.groupId, auth.familyId],
    );
    if (!group.rowCount) throw new AppError("AGENT_GROUP_NOT_REGISTERED", "Группа больше не подключена");
    return;
  }
  const member = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
    [auth.familyId, auth.userId],
  );
  if (!member.rowCount) throw new AppError("AGENT_ACCESS_DENIED", "Доступ к семейному агенту был отозван");
}

async function lockThread(
  client: PoolClient,
  auth: MemoryAuthorization,
  threadRef: string,
): Promise<ThreadIdentityRow> {
  if (!THREAD_REF_PATTERN.test(threadRef)) {
    throw new AppError("AGENT_MEMORY_THREAD_REF_INVALID", "Некорректная ссылка на нить памяти");
  }
  const result = await client.query<ThreadIdentityRow>(
    `SELECT thread.id, thread.thread_ref, thread.family_id, thread.scope,
            thread.scope_partition_key, thread.subject_user_id, thread.subject_participant_id,
            thread.subject_conversation_id, thread.memory_project_id, thread.parent_thread_id,
            thread.status::text
     FROM memory_threads AS thread
     WHERE thread.thread_ref = $1 AND thread.family_id = $2
       AND ${authorizedPredicate("thread")} FOR UPDATE`,
    [threadRef, auth.familyId, auth.scopes, auth.userId, auth.groupId],
  );
  const thread = result.rows[0];
  if (!thread) throw new AppError("AGENT_MEMORY_THREAD_NOT_FOUND", "Нить памяти не найдена");
  return thread;
}

async function verifyCurrentStatement(
  client: PoolClient,
  auth: MemoryAuthorization,
  thread: ThreadIdentityRow,
  turn: VerifiedTurnAuthority,
  requireCompletionSignal: boolean,
): Promise<{ content: string; observedAt: Date } > {
  const result = await client.query<{ content_text: string; sent_at: Date }>(
    `SELECT message.content_text, message.sent_at
     FROM telegram_group_messages AS message
     JOIN application_conversations AS conversation ON conversation.id = message.conversation_id
     WHERE message.id = $1 AND conversation.id = $2 AND conversation.family_id = $3
       AND conversation.scope = $4 AND conversation.scope_partition_key = $5
       AND message.actor_kind = 'user' AND message.telegram_user_id = $6
       AND message.content_text IS NOT NULL`,
    [turn.timelineEntryId, turn.conversationId, auth.familyId, thread.scope,
      thread.scope_partition_key, auth.telegramUserId],
  );
  const row = result.rows[0];
  if (!row || !row.content_text.trim()) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_AUTHORITY_INVALID",
      "Завершение нити требует текущего проверенного сообщения пользователя",
    );
  }
  if (requireCompletionSignal) requireExplicitCompletionStatement(row.content_text);
  return { content: row.content_text, observedAt: row.sent_at };
}

async function loadSourceEntries(
  client: PoolClient,
  threadId: string,
  entryRefs: readonly string[],
): Promise<SourceEntryRow[]> {
  const refs = [...new Set(entryRefs)];
  if (refs.length === 0 || refs.length !== entryRefs.length ||
    refs.some((ref) => !THREAD_ENTRY_REF_PATTERN.test(ref))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_COMPLETION_SOURCES_INVALID",
      "Завершение нити требует неповторяющихся source entry refs",
    );
  }
  const result = await client.query<SourceEntryRow>(
    `SELECT entry.entry_ref, entry.source_claim_id, entry.role::text
     FROM memory_thread_entries AS entry
     JOIN memory_items AS claim ON claim.id = entry.source_claim_id
     WHERE entry.thread_id = $1 AND entry.entry_ref = ANY($2::text[])
       AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
       AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
       AND entry.role IN ('goal', 'method', 'decision', 'episode', 'outcome', 'lesson', 'open_loop')`,
    [threadId, refs],
  );
  if (result.rows.length !== refs.length ||
    !result.rows.some((row) => ["goal", "decision", "outcome", "lesson"].includes(row.role))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_COMPLETION_SOURCES_INVALID",
      "Completion episode требует goal, result, decision или lesson source",
    );
  }
  return result.rows;
}

function outcomeSourceRole(role: SourceEntryRow["role"]): string {
  return role === "outcome" ? "result" : role;
}

async function createCompletionOutcome(
  client: PoolClient,
  auth: MemoryAuthorization,
  thread: ThreadIdentityRow,
  authority: CompletionAuthority,
  turn: VerifiedTurnAuthority,
  sources: readonly SourceEntryRow[],
): Promise<{ id: string; occurredAt: Date }> {
  let applicationEventId: string;
  let authorityKind: "application_event" | "formal_goal_condition" | "verified_user_statement";
  let sourceConversationId: string | null = null;
  let sourceTimelineEntryId: string | null = null;
  let sourceSnapshot: unknown;
  let summary: string;
  let occurredAt: Date;

  if (authority.kind === "current_user_statement") {
    const statement = await verifyCurrentStatement(client, auth, thread, turn, true);
    const event = await client.query<{ id: string }>(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'memory_thread.completed_by_user', $3,
               jsonb_build_object('conversationId', $4::text, 'timelineEntryId', $5::text))
       RETURNING id`,
      [auth.familyId, auth.userId, thread.id, turn.conversationId, turn.timelineEntryId],
    );
    applicationEventId = event.rows[0]!.id;
    authorityKind = "verified_user_statement";
    sourceConversationId = turn.conversationId;
    sourceTimelineEntryId = turn.timelineEntryId;
    sourceSnapshot = { content: statement.content, observedAt: statement.observedAt.toISOString() };
    summary = statement.content;
    occurredAt = statement.observedAt;
  } else {
    const outcome = await client.query<{
      application_event_id: string;
      authority: "application_event" | "formal_goal_condition" | "verified_user_statement";
      id: string;
      occurred_at: Date;
      summary: string;
    }>(
      `SELECT outcome.id, outcome.application_event_id, outcome.authority::text,
              outcome.summary, outcome.occurred_at
       FROM confirmed_outcomes AS outcome
       WHERE outcome.outcome_ref = $1 AND outcome.family_id = $2
         AND outcome.scope = $3 AND outcome.scope_partition_key = $4
         AND outcome.subject_user_id IS NOT DISTINCT FROM $5::uuid
         AND outcome.subject_participant_id IS NOT DISTINCT FROM $6::uuid
         AND outcome.memory_project_id IS NOT DISTINCT FROM $7::uuid
         AND outcome.status = 'confirmed' FOR SHARE`,
      [authority.outcomeRef, thread.family_id, thread.scope, thread.scope_partition_key,
        thread.subject_user_id, thread.subject_participant_id, thread.memory_project_id],
    );
    const existing = outcome.rows[0];
    if (!existing || (authority.kind === "formal_goal_condition" &&
      existing.authority !== "formal_goal_condition")) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_AUTHORITY_INVALID",
        "Указанный подтверждённый результат не доказывает завершение этой нити",
      );
    }
    applicationEventId = existing.application_event_id;
    authorityKind = authority.kind === "formal_goal_condition"
      ? "formal_goal_condition"
      : "application_event";
    sourceSnapshot = { sourceOutcomeRef: authority.outcomeRef };
    summary = existing.summary;
    occurredAt = existing.occurred_at;
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO confirmed_outcomes
       (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
        subject_conversation_id, memory_project_id, outcome_kind, authority,
        application_event_id, source_conversation_id, source_timeline_entry_id,
        source_snapshot, summary, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'completion_episode', $8, $9, $10, $11,
             $12::jsonb, $13, $14) RETURNING id`,
    [thread.family_id, thread.scope, thread.scope_partition_key, thread.subject_user_id,
      thread.subject_participant_id, thread.subject_conversation_id, thread.memory_project_id,
      authorityKind, applicationEventId, sourceConversationId, sourceTimelineEntryId,
      JSON.stringify(sourceSnapshot), summary, occurredAt],
  );
  const outcomeId = inserted.rows[0]!.id;
  for (const source of sources) {
    await client.query(
      `INSERT INTO confirmed_outcome_source_claims
         (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [outcomeId, source.source_claim_id, thread.family_id, thread.scope,
        thread.scope_partition_key, outcomeSourceRole(source.role)],
    );
  }
  return { id: outcomeId, occurredAt };
}

async function replayOperation(
  client: PoolClient,
  auth: MemoryAuthorization,
  operationKey: string,
  action: "complete" | "reactivate",
  inputHash: string,
): Promise<boolean> {
  const result = await client.query<{ action: string; input_hash: string }>(
    `SELECT action, input_hash FROM memory_thread_lifecycle_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const replay = result.rows[0];
  if (!replay) return false;
  if (replay.action !== action || replay.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_REPLAY_MISMATCH",
      "Повтор операции с нитью не совпадает с исходным запросом",
    );
  }
  return true;
}

export const memoryThreadLifecycleRepository = {
  async complete(
    auth: MemoryAuthorization,
    input: {
      authority: CompletionAuthority;
      operationKey: string;
      sourceEntryRefs: readonly string[];
      threadRef: string;
      turn: VerifiedTurnAuthority;
    },
  ): Promise<{ status: "completed"; threadRef: string }> {
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      if (await replayOperation(client, auth, input.operationKey, "complete", inputHash)) {
        await client.query("COMMIT");
        return { status: "completed", threadRef: input.threadRef };
      }
      await requireCurrentAccess(client, auth);
      const thread = await lockThread(client, auth, input.threadRef);
      if (thread.status !== "active") {
        throw new AppError("AGENT_MEMORY_THREAD_ALREADY_COMPLETED", "Нить памяти уже завершена");
      }
      if (thread.parent_thread_id === null) {
        throw new AppError(
          "AGENT_MEMORY_THREAD_ROOT_COMPLETION_FORBIDDEN",
          "Широкая корневая нить не завершается; завершить можно только сфокусированную поднить",
        );
      }
      const sources = await loadSourceEntries(client, thread.id, input.sourceEntryRefs);
      const outcome = await createCompletionOutcome(
        client,
        auth,
        thread,
        input.authority,
        input.turn,
        sources,
      );
      await client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_outcome_id, role, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'outcome', $6)`,
        [thread.id, thread.family_id, thread.scope, thread.scope_partition_key,
          outcome.id, outcome.occurredAt],
      );
      await client.query(
        `UPDATE memory_threads SET status = 'completed', completion_outcome_id = $2,
                completed_at = $3, generation = generation + 1, updated_at = now()
         WHERE id = $1`,
        [thread.id, outcome.id, outcome.occurredAt],
      );
      if (thread.parent_thread_id) {
        await client.query(
          `INSERT INTO memory_thread_entries
             (thread_id, family_id, scope, scope_partition_key, source_outcome_id, role, occurred_at)
           VALUES ($1, $2, $3, $4, $5, 'episode', $6)
           ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
          [thread.parent_thread_id, thread.family_id, thread.scope, thread.scope_partition_key,
            outcome.id, outcome.occurredAt],
        );
      }
      await client.query(
        `INSERT INTO memory_thread_lifecycle_operations
           (family_id, operation_key, input_hash, thread_id, action, outcome_id)
         VALUES ($1, $2, $3, $4, 'complete', $5)`,
        [auth.familyId, input.operationKey, inputHash, thread.id, outcome.id],
      );
      await client.query("COMMIT");
      return { status: "completed", threadRef: thread.thread_ref };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async reactivate(
    auth: MemoryAuthorization,
    input: { operationKey: string; threadRef: string; turn: VerifiedTurnAuthority },
  ): Promise<{ status: "active"; threadRef: string }> {
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      if (await replayOperation(client, auth, input.operationKey, "reactivate", inputHash)) {
        await client.query("COMMIT");
        return { status: "active", threadRef: input.threadRef };
      }
      await requireCurrentAccess(client, auth);
      const thread = await lockThread(client, auth, input.threadRef);
      if (thread.status !== "completed") {
        throw new AppError("AGENT_MEMORY_THREAD_REACTIVATION_INVALID", "Нить памяти уже активна");
      }
      await verifyCurrentStatement(client, auth, thread, input.turn, false);
      await client.query(
        `UPDATE memory_threads SET status = 'active', completion_outcome_id = NULL,
                completed_at = NULL, generation = generation + 1, updated_at = now()
         WHERE id = $1`,
        [thread.id],
      );
      await client.query(
        `INSERT INTO memory_thread_lifecycle_operations
           (family_id, operation_key, input_hash, thread_id, action)
         VALUES ($1, $2, $3, $4, 'reactivate')`,
        [auth.familyId, input.operationKey, inputHash, thread.id],
      );
      await client.query("COMMIT");
      return { status: "active", threadRef: thread.thread_ref };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export type { CompletionAuthority, VerifiedTurnAuthority };
