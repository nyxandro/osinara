/**
 * R3 chat-local profile and directed visibility integration tests.
 *
 * Constructs covered:
 * - Same Telegram user has isolated profile subjects and claims in external chats A and B.
 * - Personal claims never project outward; family and opted-in external self claims project inward.
 * - External projection is default-off, survives subject departure, and uses reproducible view refs.
 * - Personal export remains authoritative personal memory only.
 * - Retrieval claim identities add only their verified conversation-local profile subjects.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryExportRepository } from "./memory-export-repository.js";
import { profileProjectionPolicyRepository } from "./profile-projection-policy-repository.js";
import { profileViewRepository } from "./profile-view-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const PROFILE_SESSION_ID = "r3-profile-session";

function profileProvenance(turnId: string) {
  return { sessionId: PROFILE_SESSION_ID, turnId };
}

interface Fixture {
  externalAConversationId: string;
  externalAGroupId: string;
  externalAParticipantId: string;
  externalBConversationId: string;
  externalBGroupId: string;
  externalBParticipantId: string;
  familyConversationId: string;
  familyGroupId: string;
  familyId: string;
  ownerAuth: MemoryAuthorization;
  personalConversationId: string;
  userId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('R3 projections') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('9301', 'Анна') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const groups = await database().query<{ id: string; telegram_chat_id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-1009301', 'Семья', 'family_private', 'addressed_only'),
            ($1, '-1009302', 'External A', 'external', 'addressed_only'),
            ($1, '-1009303', 'External B', 'external', 'addressed_only')
     RETURNING id, telegram_chat_id`,
    [family.rows[0]!.id],
  );
  const familyGroupId = groups.rows.find((row) => row.telegram_chat_id === "-1009301")!.id;
  const externalAGroupId = groups.rows.find((row) => row.telegram_chat_id === "-1009302")!.id;
  const externalBGroupId = groups.rows.find((row) => row.telegram_chat_id === "-1009303")!.id;
  const personal = await conversationRepository.getByChatId("9301");
  const familyConversation = await conversationRepository.getByGroupId(familyGroupId);
  const externalA = await conversationRepository.getByGroupId(externalAGroupId);
  const externalB = await conversationRepository.getByGroupId(externalBGroupId);

  const participants = await database().query<{
    conversation_id: string;
    id: string;
  }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     SELECT conversation.id, conversation.family_id, conversation.scope,
            conversation.scope_partition_key, '9301', $2, 'Анна', now(), now()
     FROM application_conversations AS conversation
     WHERE conversation.id = ANY($1::uuid[])
     RETURNING id, conversation_id`,
    [[personal.id, familyConversation.id, externalA.id, externalB.id], user.rows[0]!.id],
  );
  return {
    externalAConversationId: externalA.id,
    externalAGroupId,
    externalAParticipantId: participants.rows.find((row) => row.conversation_id === externalA.id)!.id,
    externalBConversationId: externalB.id,
    externalBGroupId,
    externalBParticipantId: participants.rows.find((row) => row.conversation_id === externalB.id)!.id,
    familyConversationId: familyConversation.id,
    familyGroupId,
    familyId: family.rows[0]!.id,
    ownerAuth: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "9301",
      telegramActorKind: "telegram_user",
      telegramUserId: "9301",
      userId: user.rows[0]!.id,
    },
    personalConversationId: personal.id,
    userId: user.rows[0]!.id,
  };
}

async function insertClaim(input: {
  content: string;
  conversationId: string;
  evidenceKind?: "firsthand" | "inferred" | "reported";
  familyId: string;
  groupId?: string;
  ownerUserId?: string;
  scope: "family" | "group" | "personal";
  subjectParticipantId?: string;
  subjectUserId?: string;
}): Promise<string> {
  const result = await database().query<{ id: string }>(
    `INSERT INTO memory_items
         (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id,
          scope, kind, content, source, confirmation, sensitivity, operation_key,
          provenance_state, origin_conversation_id, subject_user_id,
          subject_participant_id, subject_conversation_id, profile_eligible)
       VALUES ($1, $2, $3, $4, '9301', $5, 'fact', $6, 'r3:test',
               'model_high', 'normal', $7, 'evidenced', $8::uuid, $9, $10,
               CASE WHEN $10::uuid IS NULL THEN NULL ELSE $8::uuid END, true)
       RETURNING id`,
    [input.familyId, input.ownerUserId ?? null, input.groupId ?? null, input.subjectUserId ?? null,
      input.scope, input.content, `r3:${input.scope}:${input.content}`, input.conversationId,
      input.subjectUserId ?? null, input.subjectParticipantId ?? null],
  );
  const reference = await database().query<{ memory_ref: string }>(
    "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
    [result.rows[0]!.id],
  );
  if (input.evidenceKind) {
    if (input.scope !== "group" || !input.groupId || !input.subjectParticipantId) {
      throw new Error("AGENT_TEST_EVIDENCE_FIXTURE_INVALID: evidence fixture requires a group participant");
    }
    await database().query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at, evidence_snippet,
          timeline_sequence, source_message_id, source_snapshot)
       VALUES ($1, $2, 'group', $3, 'primary', $4, $5, 'External source', $3,
               $6, (SELECT linked_user_id FROM conversation_participants WHERE id = $6),
               'Анна', now(), $7, 1, 1, jsonb_build_object('content', $7::text))`,
      [result.rows[0]!.id, input.familyId, input.groupId, input.evidenceKind,
        input.conversationId, input.subjectParticipantId, input.content],
    );
  }
  return reference.rows[0]!.memory_ref;
}

describeWithDatabase("R3 profile projections", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE claim_evidence, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("enforces directed scope visibility, default-off policy, isolation and exact views", async () => {
    const fixture = await createFixture();
    await insertClaim({
      content: "Личный секрет не выходит наружу",
      conversationId: fixture.personalConversationId,
      familyId: fixture.familyId,
      ownerUserId: fixture.userId,
      scope: "personal",
      subjectUserId: fixture.userId,
    });
    await insertClaim({
      content: "Семейный профиль виден лично",
      conversationId: fixture.familyConversationId,
      familyId: fixture.familyId,
      scope: "family",
      subjectUserId: fixture.userId,
    });
    await insertClaim({
      content: "Факт только из External A",
      conversationId: fixture.externalAConversationId,
      evidenceKind: "reported",
      familyId: fixture.familyId,
      groupId: fixture.externalAGroupId,
      scope: "group",
      subjectParticipantId: fixture.externalAParticipantId,
    });
    await insertClaim({
      content: "Модель предположила секретный внешний факт",
      conversationId: fixture.externalAConversationId,
      evidenceKind: "inferred",
      familyId: fixture.familyId,
      groupId: fixture.externalAGroupId,
      scope: "group",
      subjectParticipantId: fixture.externalAParticipantId,
    });
    await insertClaim({
      content: "Факт только из External B",
      conversationId: fixture.externalBConversationId,
      familyId: fixture.familyId,
      groupId: fixture.externalBGroupId,
      scope: "group",
      subjectParticipantId: fixture.externalBParticipantId,
    });

    const personalDefault = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("personal-default"),
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    expect(personalDefault.subjects.flatMap((subject) => subject.claims.map((claim) => claim.content)))
      .toEqual(expect.arrayContaining([
        "Личный секрет не выходит наружу",
        "Семейный профиль виден лично",
      ]));
    expect(JSON.stringify(personalDefault)).not.toContain("Факт только из External");

    const policies = await profileProjectionPolicyRepository.list(fixture.ownerAuth);
    const externalA = policies.find((policy) => policy.label === "External A")!;
    expect(policies.every((policy) => policy.enabled === false)).toBe(true);
    expect(JSON.stringify(policies)).not.toMatch(/-100930|telegramChatId|groupId/u);
    await profileProjectionPolicyRepository.update(fixture.ownerAuth, {
      enabled: true,
      groupRef: externalA.groupRef,
      operationKey: "enable-external-a",
    });

    const personalPendingNotice = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("personal-pending-notice"),
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    expect(JSON.stringify(personalPendingNotice)).not.toContain("Факт только из External A");

    const notice = await profileProjectionPolicyRepository.claimPendingGroupNotice(
      fixture.externalAGroupId,
    );
    expect(notice?.text).toMatch(/включил проекцию/iu);
    await profileProjectionPolicyRepository.markGroupNoticePresented({
      deliveryToken: notice!.deliveryToken,
      noticeRef: notice!.noticeRef,
    });

    const personalEnabled = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("personal-enabled"),
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    const enabledContents = personalEnabled.subjects.flatMap(
      (subject) => subject.claims.map((claim) => claim.content),
    );
    expect(JSON.stringify(personalEnabled)).not.toMatch(
      /-100930|externalAGroupId|externalAParticipantId|telegramUserId/u,
    );
    expect(enabledContents).toContain("Факт только из External A");
    expect(enabledContents).not.toContain("Факт только из External B");
    expect(enabledContents).not.toContain("Модель предположила секретный внешний факт");
    const reported = personalEnabled.subjects.flatMap((subject) => subject.claims)
      .find((claim) => claim.content === "Факт только из External A");
    // Происхождение объясняется один раз в шапке выборки, в записи остаётся только evidenceKind.
    expect(reported).toMatchObject({ evidenceKind: "reported", sourceAuthorLabel: "Анна" });
    await expect(profileViewRepository.read(fixture.ownerAuth, personalEnabled.profileViewRef))
      .resolves.toEqual(personalEnabled);

    const externalAAuth: MemoryAuthorization = {
      ...fixture.ownerAuth,
      groupId: fixture.externalAGroupId,
      scopes: ["group"],
    };
    const externalAView = await profileViewRepository.create(externalAAuth, {
      conversationId: fixture.externalAConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("external-a"),
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    const externalContents = JSON.stringify(externalAView);
    expect(externalContents).toContain("Факт только из External A");
    expect(externalContents).not.toMatch(/Личный секрет|Семейный профиль|External B/u);

    // Participant rows, rather than live group membership, keep later reported self evidence bound.
    const laterClaim = await insertClaim({
      content: "Позднее подтверждение после ухода",
      conversationId: fixture.externalAConversationId,
      familyId: fixture.familyId,
      groupId: fixture.externalAGroupId,
      scope: "group",
      subjectParticipantId: fixture.externalAParticipantId,
    });
    const afterDeparture = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("after-departure"),
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    expect(JSON.stringify(afterDeparture)).toContain("Позднее подтверждение после ухода");
    expect(JSON.stringify(afterDeparture)).toContain(laterClaim);

    const exported = await memoryExportRepository.begin(fixture.ownerAuth, "r3-export");
    expect(exported.map((record) => record.content)).toEqual(["Личный секрет не выходит наружу"]);
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.userId],
    );
    await expect(profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: "9301", explicitMentionTelegramUserIds: [],
      now: new Date(), provenance: profileProvenance("membership-revoked"),
      replyTelegramUserId: null, retrievalClaimIds: [],
    })).rejects.toThrowError(/AGENT_PROFILE_VIEW_MEMBERSHIP_REVOKED/u);
  });

  it("adds a verified retrieval-related subject to the current family profile view", async () => {
    const fixture = await createFixture();
    const petr = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('9302', 'Пётр') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
      [fixture.familyId, petr.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, '9302', $3, 'Пётр', now(), now())`,
      [fixture.familyConversationId, fixture.familyId, petr.rows[0]!.id],
    );
    const memoryRef = await insertClaim({
      content: "Пётр предпочитает улун",
      conversationId: fixture.familyConversationId,
      familyId: fixture.familyId,
      scope: "family",
      subjectUserId: petr.rows[0]!.id,
    });
    const claim = await database().query<{ memory_item_id: string }>(
      "SELECT memory_item_id FROM memory_item_refs WHERE memory_ref = $1",
      [memoryRef],
    );

    const view = await profileViewRepository.create({
      ...fixture.ownerAuth,
      groupId: fixture.familyGroupId,
      scopes: ["family"],
    }, {
      conversationId: fixture.familyConversationId,
      currentTelegramUserId: "9301",
      explicitMentionTelegramUserIds: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
      provenance: profileProvenance("retrieval-related"),
      replyTelegramUserId: null,
      retrievalClaimIds: [claim.rows[0]!.memory_item_id],
    });

    expect(view.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        claims: expect.arrayContaining([
          expect.objectContaining({ content: "Пётр предпочитает улун" }),
        ]),
        label: "Пётр",
        priority: "retrieval_related",
      }),
    ]));
  });
});
