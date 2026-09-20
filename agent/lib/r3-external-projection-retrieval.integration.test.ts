/**
 * R3 external self-projection retrieval integration tests.
 *
 * Constructs covered:
 * - Automatic retrieval and `search_memories` repository path are default-off for external claims.
 * - Enabled private projection admits only claims bound to the current verified user, including later claims.
 * - External A/B retrieval remains isolated and private list does not inherit projected group records.
 * - Authorized unresolved conflicts render both incoming versions without internal identity leakage.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { toModelMemory } from "./model-memory.js";
import { profileProjectionPolicyRepository } from "./profile-projection-policy-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const QUERY_VECTOR = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0);

interface Fixture {
  externalA: { conversationId: string; groupId: string; otherParticipantId: string; selfParticipantId: string };
  externalB: { conversationId: string; groupId: string; selfParticipantId: string };
  otherUserId: string;
  ownerAuth: MemoryAuthorization;
  ownerUserId: string;
  personalConversationId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('R3 retrieval') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('9701', 'Анна'), ('9702', 'Пётр') RETURNING id, telegram_user_id`,
  );
  const owner = users.rows.find((row) => row.telegram_user_id === "9701")!;
  const other = users.rows.find((row) => row.telegram_user_id === "9702")!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, other.id],
  );
  const groups = await database().query<{ id: string; telegram_chat_id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-1009701', 'External A', 'external', 'addressed_only'),
            ($1, '-1009702', 'External B', 'external', 'addressed_only')
     RETURNING id, telegram_chat_id`,
    [family.rows[0]!.id],
  );
  const groupA = groups.rows.find((row) => row.telegram_chat_id === "-1009701")!;
  const groupB = groups.rows.find((row) => row.telegram_chat_id === "-1009702")!;
  const conversationA = await conversationRepository.getByGroupId(groupA.id);
  const conversationB = await conversationRepository.getByGroupId(groupB.id);
  const personal = await conversationRepository.getByChatId("9701");
  const participants = await database().query<{
    conversation_id: string;
    id: string;
    telegram_user_id: string;
  }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     SELECT conversation.id, conversation.family_id, conversation.scope,
            conversation.scope_partition_key, identity.telegram_user_id,
            identity.user_id, identity.label, now(), now()
     FROM application_conversations AS conversation
     CROSS JOIN (VALUES
       ('9701'::text, $3::uuid, 'Анна'::text),
       ('9702'::text, $4::uuid, 'Пётр'::text)
     ) AS identity(telegram_user_id, user_id, label)
     WHERE (conversation.id = $1 OR (conversation.id = $2 AND identity.telegram_user_id = '9701'))
     RETURNING id, conversation_id, telegram_user_id`,
    [conversationA.id, conversationB.id, owner.id, other.id],
  );
  const participant = (conversationId: string, telegramUserId: string) =>
    participants.rows.find((row) =>
      row.conversation_id === conversationId && row.telegram_user_id === telegramUserId
    )!.id;
  return {
    externalA: {
      conversationId: conversationA.id,
      groupId: groupA.id,
      otherParticipantId: participant(conversationA.id, "9702"),
      selfParticipantId: participant(conversationA.id, "9701"),
    },
    externalB: {
      conversationId: conversationB.id,
      groupId: groupB.id,
      selfParticipantId: participant(conversationB.id, "9701"),
    },
    otherUserId: other.id,
    ownerAuth: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "9701",
      telegramActorKind: "telegram_user",
      telegramUserId: "9701",
      userId: owner.id,
    },
    ownerUserId: owner.id,
    personalConversationId: personal.id,
  };
}

async function insertGroupClaim(input: {
  content: string;
  conversationId: string;
  familyId: string;
  groupId: string;
  operationKey: string;
  participantId: string;
  telegramUserId: string;
}): Promise<{ id: string; memoryRef: string }> {
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
        confirmation, sensitivity, operation_key, provenance_state, origin_conversation_id,
        subject_participant_id, subject_conversation_id, profile_eligible)
     VALUES ($1, $2, $3, 'group', 'fact', $4, 'r3:retrieval', 'model_high', 'normal',
             $5, 'evidenced', $6, $7, $6, true) RETURNING id`,
    [input.familyId, input.groupId, input.telegramUserId, input.content,
      input.operationKey, input.conversationId, input.participantId],
  );
  const reference = await database().query<{ memory_ref: string }>(
    "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
    [claim.rows[0]!.id],
  );
  return { id: claim.rows[0]!.id, memoryRef: reference.rows[0]!.memory_ref };
}

async function enablePolicy(
  auth: MemoryAuthorization,
  groupId: string,
  label: string,
  operationKey: string,
): Promise<void> {
  const policy = (await profileProjectionPolicyRepository.list(auth))
    .find((candidate) => candidate.label === label)!;
  await profileProjectionPolicyRepository.update(auth, {
    enabled: true,
    groupRef: policy.groupRef,
    operationKey,
  });
  const notice = await profileProjectionPolicyRepository.claimPendingGroupNotice(groupId);
  await profileProjectionPolicyRepository.markGroupNoticePresented({
    deliveryToken: notice!.deliveryToken,
    noticeRef: notice!.noticeRef,
  });
}

describeWithDatabase("R3 external projection retrieval", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("retrieves only enabled self claims privately while external groups remain isolated", async () => {
    const fixture = await createFixture();
    const selfA = await insertGroupClaim({
      content: "Анна использует проектор Альфа", conversationId: fixture.externalA.conversationId,
      familyId: fixture.ownerAuth.familyId, groupId: fixture.externalA.groupId,
      operationKey: "self-a", participantId: fixture.externalA.selfParticipantId,
      telegramUserId: "9701",
    });
    const otherA = await insertGroupClaim({
      content: "Пётр использует проектор Бета", conversationId: fixture.externalA.conversationId,
      familyId: fixture.ownerAuth.familyId, groupId: fixture.externalA.groupId,
      operationKey: "other-a", participantId: fixture.externalA.otherParticipantId,
      telegramUserId: "9702",
    });
    await insertGroupClaim({
      content: "Анна использует проектор Гамма", conversationId: fixture.externalB.conversationId,
      familyId: fixture.ownerAuth.familyId, groupId: fixture.externalB.groupId,
      operationKey: "self-b", participantId: fixture.externalB.selfParticipantId,
      telegramUserId: "9701",
    });

    await expect(memoryRetrievalRepository.search(
      fixture.ownerAuth, "проектор", [QUERY_VECTOR],
    )).resolves.toMatchObject({ results: [] });
    await enablePolicy(
      fixture.ownerAuth, fixture.externalA.groupId, "External A", "enable-a-retrieval",
    );
    const { results: enabledA } = await memoryRetrievalRepository.search(
      fixture.ownerAuth, "проектор", [QUERY_VECTOR],
    );
    expect(enabledA.map((result) => result.memory.content)).toEqual([
      "Анна использует проектор Альфа",
    ]);
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'group', $4, 'deterministic_guard')`,
      [selfA.id, otherA.id, fixture.ownerAuth.familyId, fixture.externalA.groupId],
    );
    const unauthorizedClosure = await memoryRetrievalRepository.searchWithConflictClosure(
      fixture.ownerAuth, "проектор", [QUERY_VECTOR],
    );
    expect(unauthorizedClosure.conflicts).toEqual([]);
    expect(unauthorizedClosure.results.map((result) => result.memory.content))
      .not.toContain("Анна использует проектор Альфа");
    expect(unauthorizedClosure.relatedClaimIds).not.toContain(selfA.id);
    expect(JSON.stringify(unauthorizedClosure)).not.toMatch(
      new RegExp([otherA.id, otherA.memoryRef, "Пётр использует проектор Бета"].join("|"), "u"),
    );

    // Cross-scope disagreement stays as two read-only records; retrieval never invents a relation.
    const personalDisagreement = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, origin_conversation_id,
          subject_user_id, provenance_state, profile_eligible)
       VALUES ($1, $2, $2, '9701', 'personal', 'fact',
               'Анна не использует проектор Альфа', 'r3:retrieval', 'user_confirmed',
               'normal', 'personal-disagreement', $3, $2, 'evidenced', true)
       RETURNING id`,
      [fixture.ownerAuth.familyId, fixture.ownerUserId, fixture.personalConversationId],
    );
    const { results: independent } = await memoryRetrievalRepository.search(
      fixture.ownerAuth, "проектор Альфа", [QUERY_VECTOR],
    );
    expect(independent.map((result) => result.memory.content)).toEqual(expect.arrayContaining([
      "Анна использует проектор Альфа",
      "Анна не использует проектор Альфа",
    ]));
    await expect(database().query(
      `SELECT
         (SELECT count(*)::integer FROM claim_relations
          WHERE (source_claim_id = $1 AND target_claim_id = $2)
             OR (source_claim_id = $2 AND target_claim_id = $1)) AS relations,
         (SELECT count(*)::integer FROM claim_conflicts
          WHERE claim_a_id = LEAST($1::uuid, $2::uuid)
            AND claim_b_id = GREATEST($1::uuid, $2::uuid)) AS conflicts`,
      [selfA.id, personalDisagreement.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ conflicts: 0, relations: 0 }] });

    // A former participant needs no live external membership row; exact durable binding remains.
    await database().query(
      `UPDATE conversation_participants
       SET first_observed_at = now() - interval '90 days',
           last_observed_at = now() - interval '90 days'
       WHERE id = $1`,
      [fixture.externalA.selfParticipantId],
    );
    const later = await insertGroupClaim({
      content: "После ухода Анна выбирает проектор Дельта",
      conversationId: fixture.externalA.conversationId,
      familyId: fixture.ownerAuth.familyId,
      groupId: fixture.externalA.groupId,
      operationKey: "self-a-after-departure",
      participantId: fixture.externalA.selfParticipantId,
      telegramUserId: "9702",
    });
    const { results: afterDeparture } = await memoryRetrievalRepository.search(
      fixture.ownerAuth, "проектор", [QUERY_VECTOR],
    );
    expect(afterDeparture.map((result) => result.memory.content)).toEqual(expect.arrayContaining([
      "Анна использует проектор Альфа",
      "После ухода Анна выбирает проектор Дельта",
    ]));
    expect((await memoryRepository.list(fixture.ownerAuth, { limit: 50 })).items
      .map((item) => item.content)).toEqual(["Анна не использует проектор Альфа"]);

    const externalAAuth: MemoryAuthorization = {
      ...fixture.ownerAuth, groupId: fixture.externalA.groupId, scopes: ["group"],
    };
    const { results: externalAResults } = await memoryRetrievalRepository.search(
      externalAAuth, "проектор", [QUERY_VECTOR],
    );
    expect(externalAResults.map((result) => result.memory.content)).toEqual(expect.arrayContaining([
      "Анна использует проектор Альфа",
      "Пётр использует проектор Бета",
      "После ухода Анна выбирает проектор Дельта",
    ]));
    expect(JSON.stringify(externalAResults)).not.toContain("проектор Гамма");

    await enablePolicy(
      fixture.ownerAuth, fixture.externalB.groupId, "External B", "enable-b-retrieval",
    );
    const { results: bothEnabled } = await memoryRetrievalRepository.search(
      fixture.ownerAuth, "проектор", [QUERY_VECTOR],
    );
    const privateContents = bothEnabled.map((result) => result.memory.content);
    expect(privateContents).toEqual(expect.arrayContaining([
      "Анна использует проектор Альфа",
      "Анна использует проектор Гамма",
      "После ухода Анна выбирает проектор Дельта",
    ]));
    expect(privateContents).not.toContain("Пётр использует проектор Бета");
    const safeModels = bothEnabled.map((result) => toModelMemory(result.memory, result.sourceEvidence));
    const safe = JSON.stringify(safeModels);
    expect(safeModels).toEqual(expect.arrayContaining([
      // Пояснение вида evidence живёт один раз в шапке блока, в записи остаётся только kind.
      expect.objectContaining({ evidence: expect.objectContaining({ kind: "unresolved" }) }),
    ]));
    expect(safe).not.toMatch(new RegExp([
      selfA.id, later.id, fixture.externalA.groupId, fixture.externalB.groupId,
      personalDisagreement.rows[0]!.id,
      fixture.externalA.selfParticipantId, fixture.ownerUserId, fixture.otherUserId,
      "-1009701", "-1009702",
    ].join("|"), "u"));
    expect(safe).not.toMatch(/"(?:id|groupId|participantId|userId|telegramUserId)"/u);
  });

  it("closes an authorized incoming conflict with both versions and no silent winner", async () => {
    const fixture = await createFixture();
    await enablePolicy(
      fixture.ownerAuth, fixture.externalA.groupId, "External A", "enable-a-conflict",
    );
    const first = await insertGroupClaim({
      content: "Анна хранит проектор дома", conversationId: fixture.externalA.conversationId,
      familyId: fixture.ownerAuth.familyId, groupId: fixture.externalA.groupId,
      operationKey: "conflict-a", participantId: fixture.externalA.selfParticipantId,
      telegramUserId: "9701",
    });
    const second = await insertGroupClaim({
      content: "Анна не хранит проектор дома", conversationId: fixture.externalA.conversationId,
      familyId: fixture.ownerAuth.familyId, groupId: fixture.externalA.groupId,
      operationKey: "conflict-b", participantId: fixture.externalA.selfParticipantId,
      telegramUserId: "9702",
    });
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'group', $4, 'deterministic_guard')`,
      [first.id, second.id, fixture.ownerAuth.familyId, fixture.externalA.groupId],
    );

    const retrieval = await memoryRetrievalRepository.searchWithConflictClosure(
      fixture.ownerAuth, "проектор дома", [QUERY_VECTOR],
    );

    expect(retrieval.conflicts).toHaveLength(1);
    expect(retrieval.conflicts[0]!.versions.map((version) => version.content).sort()).toEqual([
      "Анна не хранит проектор дома",
      "Анна хранит проектор дома",
    ]);
    expect(retrieval.results.map((result) => result.memory.memoryRef))
      .not.toEqual(expect.arrayContaining([first.memoryRef, second.memoryRef]));
    expect(JSON.stringify(retrieval.conflicts)).not.toMatch(
      new RegExp([first.id, second.id, fixture.externalA.groupId,
        fixture.externalA.selfParticipantId].join("|"), "u"),
    );
    await expect(database().query(
      "SELECT claim_status::text FROM memory_items WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[first.id, second.id]],
    )).resolves.toMatchObject({ rows: [{ claim_status: "active" }, { claim_status: "active" }] });
  });
});
