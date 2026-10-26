/**
 * One-prompt-per-chat PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Any active participant can replace or append the exact current chat prompt.
 * - Optimistic revision rejects lost updates while exact tool replay stays idempotent.
 * - Concurrent first writes cannot both commit revision one.
 * - Chat isolation, membership revocation, and timeline pruning remain enforced.
 */
import { afterAll, describe, expect, it } from "vitest";

import type { BehaviorPreferenceAuthorization } from "./behavior-preference-context.js";
import { behaviorPreferenceRepository } from "./behavior-preference-repository.js";
import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

interface Fixture {
  externalConversationId: string;
  externalGroupId: string;
  externalTelegramUserId: string;
  familyConversationId: string;
  familyGroupId: string;
  familyId: string;
  memberTelegramUserId: string;
  memberUserId: string;
  ownerTelegramUserId: string;
  privateConversationId: string;
}

async function createFixture(suffix: string): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Prompt family ${suffix}`],
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Owner'), ($2, 'Member') RETURNING id, telegram_user_id`,
    [`prompt-owner-${suffix}`, `prompt-member-${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `prompt-owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `prompt-member-${suffix}`)!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, member.id],
  );
  const groups = await database().query<{ id: string; type: "external" | "family_private" }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, 'Prompt family group', 'family_private', 'all'),
            ($1, $3, 'Prompt external group', 'external', 'all') RETURNING id, type`,
    [family.rows[0]!.id, `-100-prompt-family-${suffix}`, `-100-prompt-external-${suffix}`],
  );
  const familyGroup = groups.rows.find((row) => row.type === "family_private")!;
  const externalGroup = groups.rows.find((row) => row.type === "external")!;
  const conversations = await database().query<{
    id: string;
    owner_user_id: string | null;
    telegram_group_id: string | null;
  }>(
    "SELECT id, owner_user_id, telegram_group_id FROM application_conversations WHERE family_id = $1",
    [family.rows[0]!.id],
  );
  return {
    externalConversationId: conversations.rows.find(
      (row) => row.telegram_group_id === externalGroup.id,
    )!.id,
    externalGroupId: externalGroup.id,
    externalTelegramUserId: `external-participant-${suffix}`,
    familyConversationId: conversations.rows.find(
      (row) => row.telegram_group_id === familyGroup.id,
    )!.id,
    familyId: family.rows[0]!.id,
    familyGroupId: familyGroup.id,
    memberTelegramUserId: member.telegram_user_id,
    memberUserId: member.id,
    ownerTelegramUserId: owner.telegram_user_id,
    privateConversationId: conversations.rows.find((row) => row.owner_user_id === owner.id)!.id,
  };
}

async function source(
  conversationId: string,
  telegramUserId: string,
): Promise<BehaviorPreferenceAuthorization> {
  const conversation = await database().query<{
    sequence_id: string;
    telegram_group_id: string | null;
  }>(
    `UPDATE application_conversations SET next_timeline_sequence = next_timeline_sequence + 1
     WHERE id = $1 RETURNING next_timeline_sequence::text AS sequence_id, telegram_group_id`,
    [conversationId],
  );
  const current = conversation.rows[0]!;
  const sentAt = new Date().toISOString();
  const entry = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', $4, $5, 'Prompt author', false, 'text',
             'Update the operational prompt', $6) RETURNING id`,
    [conversationId, current.telegram_group_id, current.sequence_id,
      `telegram:${telegramUserId}`, telegramUserId, sentAt],
  );
  return {
    conversationId,
    sourceSequence: current.sequence_id,
    telegramUserId,
    timelineEntryId: entry.rows[0]!.id,
  };
}

describeWithDatabase("behaviorPreferenceRepository", () => {
  afterAll(closeDatabase);

  it("lets another active member replace the whole prompt", async () => {
    const fixture = await createFixture("replace");
    const owner = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    const member = await source(fixture.familyConversationId, fixture.memberTelegramUserId);

    await expect(behaviorPreferenceRepository.mutate(owner, {
      action: "replace",
      content: "Не шути.",
      expectedRevision: 0,
    })).resolves.toMatchObject({ content: "Не шути.", revision: 1 });
    await expect(behaviorPreferenceRepository.mutate(member, {
      action: "replace",
      content: "Шути, когда это уместно.",
      expectedRevision: 1,
    })).resolves.toMatchObject({ content: "Шути, когда это уместно.", revision: 2 });
  });

  it("isolates the prompt by exact chat", async () => {
    const fixture = await createFixture("isolation");
    const family = await source(fixture.familyConversationId, fixture.memberTelegramUserId);
    const personal = await source(fixture.privateConversationId, fixture.ownerTelegramUserId);
    await behaviorPreferenceRepository.mutate(family, {
      action: "replace",
      content: "Семейный prompt.",
      expectedRevision: 0,
    });

    await expect(behaviorPreferenceRepository.get(personal)).resolves.toEqual({
      content: "",
      revision: 0,
      updatedAt: null,
    });
    await expect(behaviorPreferenceRepository.get(family)).resolves.toMatchObject({
      content: "Семейный prompt.",
      revision: 1,
    });
    await expect(behaviorPreferenceRepository.get({
      actorUserId: fixture.memberUserId,
      familyId: fixture.familyId,
      groupId: fixture.familyGroupId,
      kind: "scheduled",
      scope: "family",
      telegramChatId: `-100-prompt-family-isolation`,
    })).resolves.toMatchObject({ content: "Семейный prompt.", revision: 1 });
    await expect(behaviorPreferenceRepository.get({
      actorUserId: fixture.memberUserId,
      familyId: fixture.familyId,
      groupId: null,
      kind: "scheduled",
      scope: "personal",
      telegramChatId: fixture.memberTelegramUserId,
    })).resolves.toEqual({ content: "", revision: 0, updatedAt: null });
  });

  it("allows an external participant without family identity only in its registered chat", async () => {
    const fixture = await createFixture("external");
    const external = await source(
      fixture.externalConversationId,
      fixture.externalTelegramUserId,
    );

    await expect(behaviorPreferenceRepository.mutate(external, {
      action: "replace",
      content: "Не используй эмодзи.",
      expectedRevision: 0,
    })).resolves.toMatchObject({ content: "Не используй эмодзи.", revision: 1 });

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [fixture.externalGroupId]);
    await expect(behaviorPreferenceRepository.get(external)).rejects.toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED/u,
    );
  });

  it("rejects a source actor or sequence substituted into another private chat", async () => {
    const fixture = await createFixture("source-substitution");
    const wrongActor = await source(
      fixture.privateConversationId,
      fixture.memberTelegramUserId,
    );
    await expect(behaviorPreferenceRepository.get(wrongActor)).rejects.toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED/u,
    );
    await expect(behaviorPreferenceRepository.get({
      ...wrongActor,
      sourceSequence: String(Number(wrongActor.sourceSequence) + 1),
    })).rejects.toThrowError(/AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED/u);
  });

  it("appends independent text and lets the agent rewrite everything from scratch", async () => {
    const fixture = await createFixture("editing");
    const first = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    const second = await source(fixture.familyConversationId, fixture.memberTelegramUserId);
    const third = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    await behaviorPreferenceRepository.mutate(first, {
      action: "replace",
      content: "Не шути.",
      expectedRevision: 0,
    });
    await expect(behaviorPreferenceRepository.mutate(second, {
      action: "append",
      content: "Разделяй абзацы пустой строкой.",
      expectedRevision: 1,
    })).resolves.toMatchObject({
      content: "Не шути.\nРазделяй абзацы пустой строкой.",
      revision: 2,
    });
    await expect(behaviorPreferenceRepository.mutate(third, {
      action: "replace",
      content: "Пиши спокойно и разделяй абзацы пустой строкой.",
      expectedRevision: 2,
    })).resolves.toMatchObject({
      content: "Пиши спокойно и разделяй абзацы пустой строкой.",
      revision: 3,
    });
  });

  it("returns exact replay and rejects a stale revision", async () => {
    const fixture = await createFixture("revision");
    const first = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    const mutation = { action: "replace" as const, content: "Prompt v1.", expectedRevision: 0 };
    const saved = await behaviorPreferenceRepository.mutate(first, mutation);

    await expect(behaviorPreferenceRepository.mutate(first, mutation)).resolves.toEqual(saved);
    const stale = await source(fixture.familyConversationId, fixture.memberTelegramUserId);
    await expect(behaviorPreferenceRepository.mutate(stale, {
      action: "append",
      content: "Опоздавшее изменение.",
      expectedRevision: 0,
    })).rejects.toThrowError(/AGENT_BEHAVIOR_PREFERENCE_REVISION_CONFLICT/u);
  });

  it("lets one turn edit the notes again, but not a turn of an older message", async () => {
    const fixture = await createFixture("same-turn");
    const older = await source(fixture.privateConversationId, fixture.ownerTelegramUserId);
    const current = await source(fixture.privateConversationId, fixture.ownerTelegramUserId);

    await behaviorPreferenceRepository.mutate(current, {
      action: "append", content: "Пух улетает сегодня в 18:00 +03:00.", expectedRevision: 0,
    });
    // The agent tidies the notes in the same turn: a second edit of one message is not an old one.
    await expect(behaviorPreferenceRepository.mutate(current, {
      action: "replace", content: "Пух улетает 26.10.2026 в 18:00 +03:00.", expectedRevision: 1,
    })).resolves.toMatchObject({ content: "Пух улетает 26.10.2026 в 18:00 +03:00.", revision: 2 });
    await expect(behaviorPreferenceRepository.mutate(older, {
      action: "clear", expectedRevision: 2,
    })).rejects.toThrowError(/AGENT_BEHAVIOR_PREFERENCE_REVISION_CONFLICT/u);
  });

  it("serializes concurrent first writes before a prompt row exists", async () => {
    const fixture = await createFixture("concurrent-first-write");
    const owner = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    const member = await source(fixture.familyConversationId, fixture.memberTelegramUserId);

    const results = await Promise.allSettled([
      behaviorPreferenceRepository.mutate(owner, {
        action: "replace",
        content: "Первый вариант.",
        expectedRevision: 0,
      }),
      behaviorPreferenceRepository.mutate(member, {
        action: "replace",
        content: "Второй вариант.",
        expectedRevision: 0,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "AGENT_BEHAVIOR_PREFERENCE_REVISION_CONFLICT",
    });
  });

  it("keeps the prompt after source pruning and rejects revoked membership", async () => {
    const fixture = await createFixture("boundary");
    const initial = await source(fixture.familyConversationId, fixture.ownerTelegramUserId);
    await behaviorPreferenceRepository.mutate(initial, {
      action: "replace",
      content: "Сохрани этот prompt.",
      expectedRevision: 0,
    });
    const member = await source(fixture.familyConversationId, fixture.memberTelegramUserId);
    await expect(database().query(
      "DELETE FROM telegram_group_messages WHERE id = $1",
      [initial.timelineEntryId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(behaviorPreferenceRepository.get(member)).resolves.toMatchObject({
      content: "Сохрани этот prompt.",
    });

    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.memberUserId],
    );
    await expect(behaviorPreferenceRepository.get(member)).rejects.toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED/u,
    );
    await expect(behaviorPreferenceRepository.get({
      actorUserId: fixture.memberUserId,
      familyId: fixture.familyId,
      groupId: null,
      kind: "scheduled",
      scope: "personal",
      telegramChatId: fixture.memberTelegramUserId,
    })).rejects.toThrowError(/AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED/u);
  });
});
