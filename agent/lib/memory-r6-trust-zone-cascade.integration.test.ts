/**
 * Complete R6 trust-zone cascade integration tests.
 *
 * Constructs covered:
 * - External group deletion removes every project/outcome/thread descendant.
 * - Family group deletion preserves family roots while erasing source coordinates, retracting the
 *   completion projection, and retaining scoped audit/lifecycle rows.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";
import { createMemoryThreadBriefRepository } from "./memory-thread-brief-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

interface ZoneFixture {
  claimId: string;
  conversationId: string;
  groupId: string;
  outcomeId: string;
  projectId: string;
  threadId: string;
}

async function createZone(input: {
  familyId: string;
  scope: "family" | "group";
  suffix: string;
  userId: string;
}): Promise<ZoneFixture> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, $4, 'addressed_only') RETURNING id`,
    [input.familyId, `-100-r6-all-${input.suffix}`, `${input.scope} all R6`,
      input.scope === "group" ? "external" : "family_private"],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [group.rows[0]!.id],
  );
  const partition = input.scope === "group" ? group.rows[0]!.id : input.familyId;
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, $3, $4, 'r6-all-owner', $5, 'Owner', now(), now()) RETURNING id`,
    [conversation.rows[0]!.id, input.familyId, input.scope, partition, input.userId],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, 1, 'user', 'telegram:r6-all-owner', 'r6-all-owner', 'Owner', false,
             'text', $4, now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id,
      input.scope === "group" ? 8101 : 8102, `${input.scope} source`],
  );
  const project = await database().query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.familyId, input.scope === "group" ? group.rows[0]!.id : null,
      input.scope, partition, `${input.scope} complete project`],
  );
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, group_id, author_user_id, author_telegram_user_id, scope, kind, content,
        source, confirmation, sensitivity, operation_key, provenance_state,
        origin_conversation_id, memory_project_id, save_approved, content_normalized,
        profile_eligible)
     VALUES ($1, $2, $3, $4, $5, 'episode', $6, 'test:r6-all', 'user_confirmed', 'normal',
             $7, 'evidenced', $8, $9, true, lower($6), false) RETURNING id`,
    [input.familyId, input.scope === "group" ? group.rows[0]!.id : null, input.userId,
      input.scope === "group" ? "r6-all-owner" : null, input.scope, `${input.scope} claim`,
      `r6-all-claim-${input.suffix}`, conversation.rows[0]!.id, project.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, observed_at, evidence_snippet,
        timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, $3, $4, 'primary', 'firsthand', $5, $6, $7, $8, $9, now(), $10,
             $11, 1, $12, '{}'::jsonb)`,
    [claim.rows[0]!.id, input.familyId, input.scope, partition, conversation.rows[0]!.id,
      `${input.scope} origin`, group.rows[0]!.id, participant.rows[0]!.id, input.userId,
      `${input.scope} source`, timeline.rows[0]!.id, input.scope === "group" ? 8101 : 8102],
  );
  const event = await database().query<{ id: string }>(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.familyId, input.userId, `r6.${input.suffix}.confirmed`],
  );
  const outcome = await database().query<{ id: string }>(
    `INSERT INTO confirmed_outcomes
       (family_id, scope, scope_partition_key, memory_project_id, outcome_kind, authority,
        application_event_id, source_conversation_id, source_timeline_entry_id,
        source_snapshot, summary, occurred_at)
     VALUES ($1, $2, $3, $4, 'completion_episode', $5, $6, $7, $8, '{}'::jsonb, $9, now())
     RETURNING id`,
    [input.familyId, input.scope, partition, project.rows[0]!.id,
      input.scope === "family" ? "verified_user_statement" : "application_event",
      event.rows[0]!.id, input.scope === "family" ? conversation.rows[0]!.id : null,
      input.scope === "family" ? timeline.rows[0]!.id : null, `${input.scope} outcome`],
  );
  await database().query(
    `INSERT INTO confirmed_outcome_source_claims
       (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
     VALUES ($1, $2, $3, $4, $5, 'result')`,
    [outcome.rows[0]!.id, claim.rows[0]!.id, input.familyId, input.scope, partition],
  );
  await database().query(
    `INSERT INTO confirmed_outcome_operations
       (family_id, operation_key, input_hash, action, outcome_id)
     VALUES ($1, $2, repeat('a', 64), 'create', $3)`,
    [input.familyId, `r6-all-outcome-${input.suffix}`, outcome.rows[0]!.id],
  );
  const thread = await database().query<{ id: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
        status, completion_outcome_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Complete cascade', 'completed', $6, now()) RETURNING id`,
    [input.familyId, input.scope, partition, project.rows[0]!.id,
      `${input.scope} complete thread`, outcome.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id,
        source_outcome_id, role, occurred_at)
     VALUES ($1, $2, $3, $4, $5, NULL, 'goal', now()),
            ($1, $2, $3, $4, NULL, $6, 'outcome', now())`,
    [thread.rows[0]!.id, input.familyId, input.scope, partition,
      claim.rows[0]!.id, outcome.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_creation_notices
       (thread_id, family_id, status, origin_conversation_id, delivery_started_at,
        delivery_diagnostic_code)
     VALUES ($1, $2, 'failed', $3, now(), 'AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY')`,
    [thread.rows[0]!.id, input.familyId, conversation.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_lifecycle_operations
       (family_id, operation_key, input_hash, thread_id, action, outcome_id)
     VALUES ($1, $2, repeat('b', 64), $3, 'complete', $4)`,
    [input.familyId, `r6-all-lifecycle-${input.suffix}`, thread.rows[0]!.id, outcome.rows[0]!.id],
  );
  return {
    claimId: claim.rows[0]!.id,
    conversationId: conversation.rows[0]!.id,
    groupId: group.rows[0]!.id,
    outcomeId: outcome.rows[0]!.id,
    projectId: project.rows[0]!.id,
    threadId: thread.rows[0]!.id,
  };
}

describeWithDatabase("complete R6 trust-zone cascade", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("cascades external descendants and safely retires family completion descendants", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('All R6 cascade') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('r6-all-owner', 'Owner') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const external = await createZone({
      familyId: family.rows[0]!.id,
      scope: "group",
      suffix: "external",
      userId: user.rows[0]!.id,
    });
    const familyZone = await createZone({
      familyId: family.rows[0]!.id,
      scope: "family",
      suffix: "family",
      userId: user.rows[0]!.id,
    });

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [external.groupId]);
    await expect(database().query(
      `SELECT
         EXISTS (SELECT 1 FROM memory_projects WHERE id = $1) AS project,
         EXISTS (SELECT 1 FROM confirmed_outcomes WHERE id = $2) AS outcome,
         EXISTS (SELECT 1 FROM memory_threads WHERE id = $3) AS thread,
         EXISTS (SELECT 1 FROM memory_items WHERE id = $4) AS claim,
         (SELECT count(*)::integer FROM confirmed_outcome_source_claims
          WHERE outcome_id = $2) AS outcome_sources,
         (SELECT count(*)::integer FROM confirmed_outcome_operations
          WHERE outcome_id = $2) AS outcome_operations,
         (SELECT count(*)::integer FROM memory_thread_entries
          WHERE thread_id = $3) AS thread_entries,
         (SELECT count(*)::integer FROM memory_thread_creation_notices
          WHERE thread_id = $3) AS creation_notices,
         (SELECT count(*)::integer FROM memory_thread_lifecycle_operations
          WHERE thread_id = $3) AS lifecycle_operations`,
      [external.projectId, external.outcomeId, external.threadId, external.claimId],
    )).resolves.toMatchObject({
      rows: [{
        claim: false,
        creation_notices: 0,
        lifecycle_operations: 0,
        outcome: false,
        outcome_operations: 0,
        outcome_sources: 0,
        project: false,
        thread: false,
        thread_entries: 0,
      }],
    });

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [familyZone.groupId]);
    await expect(database().query(
      `SELECT outcome.status::text, outcome.source_conversation_id, outcome.source_erased_at,
              thread.status::text AS thread_status, thread.completion_outcome_id,
              claim.provenance_state::text,
              EXISTS (SELECT 1 FROM memory_projects WHERE id = $4) AS project_survives,
               (SELECT count(*)::integer FROM memory_thread_entries
                WHERE thread_id = thread.id AND source_outcome_id IS NOT NULL) AS outcome_entries,
               (SELECT count(*)::integer FROM memory_thread_entries
                WHERE thread_id = thread.id AND source_claim_id IS NOT NULL) AS claim_entries,
               (SELECT count(*)::integer FROM confirmed_outcome_source_claims
                WHERE outcome_id = outcome.id) AS outcome_sources,
               (SELECT count(*)::integer FROM confirmed_outcome_operations
                WHERE outcome_id = outcome.id) AS outcome_operations,
               (SELECT count(*)::integer FROM memory_thread_creation_notices
                WHERE thread_id = thread.id) AS creation_notices,
               (SELECT count(*)::integer FROM memory_thread_lifecycle_operations
                WHERE thread_id = thread.id) AS lifecycle_operations
       FROM confirmed_outcomes AS outcome
       JOIN memory_threads AS thread ON thread.id = $2
       JOIN memory_items AS claim ON claim.id = $3
       WHERE outcome.id = $1`,
      [familyZone.outcomeId, familyZone.threadId, familyZone.claimId, familyZone.projectId],
    )).resolves.toMatchObject({
      rows: [{
        claim_entries: 0,
        completion_outcome_id: null,
        creation_notices: 0,
        lifecycle_operations: 1,
        outcome_entries: 0,
        outcome_operations: 1,
        outcome_sources: 1,
        project_survives: true,
        provenance_state: "legacy_unresolved",
        source_conversation_id: null,
        source_erased_at: expect.any(Date),
        status: "retracted",
        thread_status: "active",
      }],
    });

    // Erased provenance may remain as family audit history, but must never regenerate model context.
    const briefs = createMemoryThreadBriefRepository();
    await expect(briefs.activate({
      auth: {
        familyId: family.rows[0]!.id,
        groupId: null,
        role: "owner",
        scopes: ["family"],
        telegramActorId: "r6-all-owner",
        telegramActorKind: "telegram_user",
        telegramUserId: "r6-all-owner",
        userId: user.rows[0]!.id,
      },
      queryEmbedding: Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
      retrievedClaimIds: [familyZone.claimId],
      skillHints: [],
    })).resolves.toEqual({ threads: [], totalCharacters: 0 });
  });
});
