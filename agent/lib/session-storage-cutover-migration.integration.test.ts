/**
 * Migration 065: application-session cutover of the v0.32 workflow storage.
 *
 * Constructs covered:
 * - Migration 065 audits and deletes every application session through the real pre-065 FK graph.
 * - Dispatched schedule/ingress work becomes terminal and non-retryable with a stable diagnostic.
 * - Undispatched leased ingress returns to pending only before a provider call or with a saved transcript.
 * - Long-term memory, timeline, workspace, and schedule history survive the clean cut.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const MIGRATION_NAME = "065_eve_032_session_storage_cutover.sql";
const TEST_SCHEMA = "test_eve_032_session_cutover";
const CUTOVER_CODE = "AGENT_EVE_032_SESSION_CUTOVER";

async function applyEarlierMigrations(client: PoolClient): Promise<void> {
  // Executing the authored migrations builds the actual FK and CHECK constraints under test.
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("065 session storage cutover migration", () => {
  afterAll(closeDatabase);

  it("cuts incompatible sessions without deleting application-owned history", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      // The family, group, and user own representative durable application history.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('v0.32 cutover') RETURNING id",
      );
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (telegram_user_id, display_name) VALUES ('65001', 'Анна') RETURNING id",
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, user.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode, telegram_chat_type)
         VALUES ($1, '-10065001', 'Семья', 'family_private', 'addressed_only', 'supergroup')
         RETURNING id`,
        [family.rows[0]!.id],
      );

      // Two roles prove that the cut is store-wide, not limited to canonical chat sessions.
      const sessions = await client.query<{ id: string }>(
        `INSERT INTO conversation_sessions
           (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
            conversation_key, continuation_token, eve_session_id, started_at, last_activity_at)
         VALUES
           (gen_random_uuid(), 0, $1, NULL, $3, 'family', 'canonical', NULL,
            '-10065001::canonical', '-10065001::canonical', 'wrun_old_canonical', now(), now()),
           (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'scheduled', 'running',
            '65001::scheduled', '65001::scheduled', 'wrun_old_scheduled', now(), now())
         RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id, group.rows[0]!.id],
      );
      const canonicalSessionId = sessions.rows[0]!.id;
      const scheduledSessionId = sessions.rows[1]!.id;
      await client.query(
        `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
         VALUES ('-10065001::route', $1)`,
        [canonicalSessionId],
      );
      await client.query(
        `INSERT INTO telegram_hitl_approvals
           (application_session_id, eve_session_id, request_id, telegram_chat_id,
            telegram_chat_type, telegram_message_id, expected_telegram_user_id,
            callback_data, consumed_at)
         VALUES ($1, 'wrun_old_canonical', 'request-065', '-10065001', 'supergroup',
                 65010, '65001', ARRAY['approved'], now())`,
        [canonicalSessionId],
      );

      // These rows must survive via ON DELETE SET NULL or by having no session dependency.
      const timeline = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, sequence_id, actor_kind, actor_id, telegram_message_id, telegram_user_id,
            sender_display_name, sender_is_bot, message_kind, content_text, sent_at,
            application_session_id)
         VALUES ($1, 1, 'user', 'telegram:65001', 65001, '65001', 'Анна', false,
                 'text', 'История переживает cutover', now(), $2) RETURNING id`,
        [group.rows[0]!.id, canonicalSessionId],
      );
      const workspace = await client.query<{ id: string }>(
        "INSERT INTO workspaces (family_id, scope) VALUES ($1, 'family') RETURNING id",
        [family.rows[0]!.id],
      );
      const memory = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, scope, author_telegram_user_id, kind, content, source,
            confirmation, sensitivity, operation_key)
         VALUES ($1, 'family', '65001', 'fact', 'Память переживает cutover', 'test',
                 'user_confirmed', 'normal', 'v032-cutover-memory') RETURNING id`,
        [family.rows[0]!.id],
      );

      // A leased parent and dispatching run represent paid/side-effect work that cannot replay.
      const schedule = await client.query<{ id: string }>(
        `INSERT INTO agent_schedules
           (family_id, author_user_id, group_id, scope, title, user_request, scenario_prompt,
            timezone, recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at,
            telegram_chat_id, telegram_chat_type, message_thread_id, status,
            lease_token, lease_expires_at, dispatch_started_at)
         VALUES ($1, $2, $3, 'family', 'Cutover', 'Запрос', 'Сценарий', 'Europe/Moscow',
                 'once', 1, now(), now(), '-10065001', 'supergroup', 65, 'leased',
                 gen_random_uuid(), now() + interval '10 minutes', now()) RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id, group.rows[0]!.id],
      );
      const run = await client.query<{ id: string }>(
        `INSERT INTO agent_schedule_runs
           (schedule_id, family_id, scheduled_for, status, lease_token, eve_session_id,
            application_session_id, dispatch_started_at)
         VALUES ($1, $2, now(), 'dispatching', gen_random_uuid(), 'wrun_old_scheduled', $3, now())
         RETURNING id`,
        [schedule.rows[0]!.id, family.rows[0]!.id, scheduledSessionId],
      );

      // Dispatched work is ambiguous; a lease with no dispatch marker is safe to retry once.
      const queue = await client.query<{ id: string }>(
        "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('queue-065') RETURNING id",
      );
      await client.query(
        `INSERT INTO telegram_ingress_updates
            (update_id, queue_id, ingress_continuation_key, payload, status, lease_token,
             lease_expires_at, dispatch_started_at, voice_file_id, voice_file_size,
             voice_mime_type, voice_transcription_started_at, voice_transcript, voice_transcribed_at)
          VALUES
            (65001, $1, 'queue-065', '{}', 'processing', gen_random_uuid(), now() + interval '1 minute', now(), NULL, NULL, NULL, NULL, NULL, NULL),
            (65002, $1, 'queue-065', '{}', 'processing', gen_random_uuid(), now() + interval '1 minute', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (65003, $1, 'queue-065', '{}', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (65004, $1, 'queue-065', '{}', 'completed', NULL, NULL, now(), NULL, NULL, NULL, NULL, NULL, NULL),
            (65005, $1, 'queue-065', '{}', 'processing', gen_random_uuid(), now() + interval '1 minute', NULL, 'voice-interrupted', 1024, 'audio/ogg', now(), NULL, NULL),
            (65006, $1, 'queue-065', '{}', 'processing', gen_random_uuid(), now() + interval '1 minute', NULL, 'voice-complete', 1024, 'audio/ogg', now(), 'Готовый текст', now())`,
        [queue.rows[0]!.id],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      // CASCADE removes executable routes/HITL; SET NULL preserves timeline and schedule history.
      const state = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM conversation_sessions) AS sessions,
           (SELECT count(*)::integer FROM conversation_session_routes) AS routes,
           (SELECT count(*)::integer FROM telegram_hitl_approvals) AS hitl,
           (SELECT count(*)::integer FROM audit_events
             WHERE event_type = 'session.eve_032_storage_cutover') AS audits,
           (SELECT count(*)::integer FROM memory_items WHERE id = $1) AS memories,
           (SELECT count(*)::integer FROM telegram_group_messages WHERE id = $2) AS timeline,
           (SELECT count(*)::integer FROM workspaces WHERE id = $3) AS workspaces`,
        [memory.rows[0]!.id, timeline.rows[0]!.id, workspace.rows[0]!.id],
      );
      expect(state.rows).toEqual([{
        audits: 2,
        hitl: 0,
        memories: 1,
        routes: 0,
        sessions: 0,
        timeline: 1,
        workspaces: 1,
      }]);

      expect((await client.query(
        `SELECT status::text, application_session_id, completed_at IS NOT NULL AS completed,
                error_code
           FROM agent_schedule_runs WHERE id = $1`,
        [run.rows[0]!.id],
      )).rows).toEqual([{
        application_session_id: null,
        completed: true,
        error_code: CUTOVER_CODE,
        status: "ambiguous",
      }]);
      expect((await client.query(
        `SELECT status::text, lease_token, lease_expires_at, dispatch_started_at, last_error_code
           FROM agent_schedules WHERE id = $1`,
        [schedule.rows[0]!.id],
      )).rows).toEqual([{
        dispatch_started_at: null,
        last_error_code: CUTOVER_CODE,
        lease_expires_at: null,
        lease_token: null,
        status: "failed",
      }]);

      const ingress = await client.query(
        `SELECT update_id::text, status, lease_token, dispatch_started_at IS NOT NULL AS dispatched,
                completed_at IS NOT NULL AS completed, last_error_code
           FROM telegram_ingress_updates ORDER BY update_id`,
      );
      expect(ingress.rows).toEqual([
        { completed: true, dispatched: true, last_error_code: CUTOVER_CODE, lease_token: null, status: "failed", update_id: "65001" },
        { completed: false, dispatched: false, last_error_code: null, lease_token: null, status: "pending", update_id: "65002" },
        { completed: false, dispatched: false, last_error_code: null, lease_token: null, status: "pending", update_id: "65003" },
        { completed: false, dispatched: true, last_error_code: null, lease_token: null, status: "completed", update_id: "65004" },
        { completed: true, dispatched: false, last_error_code: CUTOVER_CODE, lease_token: null, status: "failed", update_id: "65005" },
        { completed: false, dispatched: false, last_error_code: null, lease_token: null, status: "pending", update_id: "65006" },
      ]);
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
