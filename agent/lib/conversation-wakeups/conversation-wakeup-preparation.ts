/**
 * Live revalidation of a claimed wake-up right before its turn.
 *
 * Exports:
 * - `PreparedConversationWakeup`: everything the turn needs after revalidation.
 * - `ConversationWakeupPreparation`: ready, withdrawn, or deferred.
 * - `prepareConversationWakeup`: checks the schedule, its author, its chat, and its conversation.
 *
 * Key constructs:
 * - The conversation must still be the chat's live canonical session. A session that the next
 *   message will replace, because it failed, counts as a changed conversation.
 * - A conversation that waits for a person's answer to an approval is not interrupted: its next
 *   turn must be that answer, so the wake-up waits and is tried again later.
 * - A queue item whose schedule no longer waits for it is closed, so it never holds the lane.
 */
import type { PoolClient } from "pg";

import { AGENT_SCHEDULE_CONVERSATION_DEFER_MILLISECONDS } from "../agent-schedules/agent-schedule-config.js";
import {
  CONVERSATION_CHANGED_CODE,
  closeWakeup,
  failUnstartedRun,
  inTransaction,
  wakeupLeaseLost,
  withdrawUnstartedRun,
} from "./conversation-wakeup-transitions.js";

export interface PreparedConversationWakeup {
  applicationConversationId: string;
  applicationSessionId: string;
  authorUserId: string;
  completedRuns: number;
  eveSessionId: string;
  familyId: string;
  forumTopicId: string | null;
  groupId: string | null;
  maxRuns: number;
  messageThreadId: string | null;
  role: "member" | "owner" | "recovery_owner";
  runId: string;
  sandboxSessionId: string;
  scenarioPrompt: string;
  scheduledFor: Date;
  scheduleId: string;
  scope: "family" | "personal";
  skillAllowlist: string[];
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  telegramUserId: string;
  timezone: string;
  title: string;
  userRequest: string;
}

export type ConversationWakeupPreparation =
  | { kind: "ready"; wakeup: PreparedConversationWakeup }
  /** No turn starts; the queue item is terminal or gone with its run. */
  | { kind: "withdrawn" }
  /** The conversation waits for a person's answer; the item is back in the queue for later. */
  | { kind: "deferred" };

export interface CanonicalRouteInput {
  groupId: string | null;
  messageThreadId: string | null;
  telegramChatId: string;
  telegramForumTopicId: string | null;
}

const STALE = {
  code: "AGENT_CONVERSATION_WAKEUP_STALE",
  message: "Сценарий пробуждения уже не ждёт этого запуска",
  status: "failed",
} as const;

interface LoadedWakeup {
  application_conversation_id: string | null;
  author_user_id: string;
  completed_runs: number;
  conversation_session_id: string | null;
  family_id: string;
  forum_topic_id: string | null;
  group_id: string | null;
  group_valid: boolean;
  max_runs: number;
  message_thread_id: string | null;
  pause_requested: boolean;
  role: "member" | "owner" | "recovery_owner" | null;
  run_id: string;
  run_status: string;
  scenario_prompt: string;
  schedule_id: string;
  schedule_status: string;
  scheduled_for: Date;
  scope: "family" | "personal";
  skill_allowlist: string[] | null;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
  telegram_user_id: string;
  timezone: string;
  title: string;
  user_request: string;
}

async function loadClaimed(client: PoolClient, claim: { id: string; leaseToken: string }): Promise<LoadedWakeup> {
  const loaded = await client.query<LoadedWakeup>(
    `SELECT schedule.id::text AS schedule_id, schedule.status::text AS schedule_status,
            run.id::text AS run_id, run.status::text AS run_status, run.scheduled_for,
            schedule.family_id::text, schedule.author_user_id::text, schedule.scope,
            schedule.group_id::text, schedule.title, schedule.user_request, schedule.scenario_prompt,
            schedule.timezone, schedule.completed_runs, schedule.max_runs, schedule.pause_requested,
            schedule.telegram_chat_id, schedule.telegram_chat_type, schedule.message_thread_id::text,
            schedule.forum_topic_id::text, schedule.conversation_session_id::text,
            membership.role, users.telegram_user_id, group_row.skill_allowlist,
            (schedule.scope = 'personal' OR group_row.id IS NOT NULL) AS group_valid,
            conversation.id::text AS application_conversation_id
       FROM telegram_ingress_wakeups wakeup
       JOIN agent_schedules schedule ON schedule.id = wakeup.schedule_id
       JOIN agent_schedule_runs run ON run.id = wakeup.run_id
       JOIN users ON users.id = schedule.author_user_id
       LEFT JOIN family_memberships membership
         ON membership.family_id = schedule.family_id AND membership.user_id = schedule.author_user_id
       LEFT JOIN telegram_groups group_row
         ON group_row.id = schedule.group_id AND group_row.family_id = schedule.family_id
        AND group_row.telegram_chat_id = schedule.telegram_chat_id AND group_row.type = 'family_private'
       LEFT JOIN application_conversations conversation ON conversation.telegram_chat_id = schedule.telegram_chat_id
      WHERE wakeup.id = $1 AND wakeup.status = 'processing' AND wakeup.lease_token = $2
        AND wakeup.dispatch_started_at IS NULL
      FOR UPDATE OF wakeup, schedule, run`,
    [claim.id, claim.leaseToken],
  );
  const row = loaded.rows[0];
  if (!row) throw wakeupLeaseLost();
  return row;
}

/**
 * Withdraws the unstarted run, and the item goes with it. Should the run be held by something else,
 * both are closed instead, so neither the lane nor the schedule stays open without an owner.
 */
async function withdraw(client: PoolClient, row: LoadedWakeup, wakeupId: string, code: string | null): Promise<void> {
  if (await withdrawUnstartedRun(client, row.schedule_id, row.run_id, code)) return;
  await failUnstartedRun(client, row.schedule_id, row.run_id, STALE.code);
  await closeWakeup(client, wakeupId, STALE);
}

async function defer(client: PoolClient, wakeupId: string): Promise<void> {
  await client.query(
    `UPDATE telegram_ingress_wakeups
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            available_at = now() + ($2 * interval '1 millisecond'), updated_at = now()
      WHERE id = $1`,
    [wakeupId, AGENT_SCHEDULE_CONVERSATION_DEFER_MILLISECONDS],
  );
  await client.query("UPDATE telegram_ingress_queues SET active_wakeup_id = NULL WHERE active_wakeup_id = $1", [wakeupId]);
}

export async function prepareConversationWakeup(
  claim: { id: string; leaseToken: string },
  canonicalRouteToken: (route: CanonicalRouteInput) => string,
): Promise<ConversationWakeupPreparation> {
  return await inTransaction(async (client) => {
    const row = await loadClaimed(client, claim);
    if (row.schedule_status !== "leased" || row.run_status !== "dispatching") {
      // Nothing waits for this item any more; left open it would hold the chat's lane for good.
      await closeWakeup(client, claim.id, STALE);
      return { kind: "withdrawn" };
    }
    if (row.pause_requested) {
      await withdraw(client, row, claim.id, null);
      return { kind: "withdrawn" };
    }
    if (row.role === null || !row.group_valid || row.application_conversation_id === null) {
      await failUnstartedRun(client, row.schedule_id, row.run_id, "AGENT_SCHEDULE_DESTINATION_REVOKED");
      await closeWakeup(client, claim.id, {
        code: "AGENT_SCHEDULE_DESTINATION_REVOKED",
        message: "Автор или чат пробуждения больше не доступны",
        status: "failed",
      });
      return { kind: "withdrawn" };
    }
    const route = canonicalRouteToken({
      groupId: row.scope === "family" ? row.group_id : null,
      messageThreadId: row.message_thread_id,
      telegramChatId: row.telegram_chat_id,
      telegramForumTopicId: row.forum_topic_id,
    });
    const session = await client.query<{
      eve_session_id: string | null;
      id: string;
      pending_operation: boolean;
      rotation_requested: boolean;
      thread_id: string;
    }>(
      `SELECT session.id::text, session.thread_id::text, session.eve_session_id, session.pending_operation,
              session.rotation_requested_at IS NOT NULL AS rotation_requested
         FROM conversation_session_routes route
         JOIN conversation_sessions session ON session.id = route.session_id
        WHERE route.base_continuation_token = $1 AND session.retired_at IS NULL AND session.kind = 'canonical'
          AND session.id = $2::uuid`,
      [route, row.conversation_session_id],
    );
    const live = session.rows[0];
    if (!live || live.eve_session_id === null || live.rotation_requested) {
      await withdraw(client, row, claim.id, CONVERSATION_CHANGED_CODE);
      return { kind: "withdrawn" };
    }
    if (live.pending_operation) {
      await defer(client, claim.id);
      return { kind: "deferred" };
    }
    return {
      kind: "ready",
      wakeup: {
        applicationConversationId: row.application_conversation_id,
        applicationSessionId: live.id,
        authorUserId: row.author_user_id,
        completedRuns: row.completed_runs,
        eveSessionId: live.eve_session_id,
        familyId: row.family_id,
        forumTopicId: row.forum_topic_id,
        groupId: row.group_id,
        maxRuns: row.max_runs,
        messageThreadId: row.message_thread_id,
        role: row.role,
        runId: row.run_id,
        sandboxSessionId: live.thread_id,
        scenarioPrompt: row.scenario_prompt,
        scheduledFor: row.scheduled_for,
        scheduleId: row.schedule_id,
        scope: row.scope,
        skillAllowlist: row.skill_allowlist ?? [],
        telegramChatId: row.telegram_chat_id,
        telegramChatType: row.telegram_chat_type,
        telegramUserId: row.telegram_user_id,
        timezone: row.timezone,
        title: row.title,
        userRequest: row.user_request,
      },
    };
  });
}
