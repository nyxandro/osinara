/**
 * PostgreSQL long-term memory integration tests.
 *
 * Constructs covered:
 * - Scope filters prevent cross-user, cross-group, and cross-family disclosure.
 * - Family and group mutations enforce author-or-owner access against current database roles.
 * - Create operations are replay-safe and physical deletion removes the searchable record.
 * - Scope quotas are enforced inside the write transaction.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryAuthorization } from "./memory-context.js";
import { closeDatabase, database } from "./database.js";
import { MEMORY_SCOPE_QUOTAS } from "./memory-config.js";
import { memoryRepository } from "./memory-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

interface FamilyFixture {
  familyId: string;
  member: MemoryAuthorization;
  owner: MemoryAuthorization;
}

async function createFamily(suffix: string): Promise<FamilyFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2), ($3, $4)
     RETURNING id, telegram_user_id`,
    [`owner-${suffix}`, `Владелец ${suffix}`, `member-${suffix}`, `Участник ${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `member-${suffix}`)!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, member.id],
  );

  return {
    familyId: family.rows[0]!.id,
    member: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "member",
      scopes: ["personal", "family"],
      telegramUserId: member.telegram_user_id,
      userId: member.id,
    },
    owner: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramUserId: owner.telegram_user_id,
      userId: owner.id,
    },
  };
}

function createInput(
  scope: "family" | "group" | "personal",
  operationKey: string,
  content = "Пользователь предпочитает короткие ответы",
) {
  return {
    confirmation: "user_confirmed" as const,
    content,
    kind: "preference" as const,
    operationKey,
    scope,
    sensitivity: "normal" as const,
    source: `eve:session:${operationKey}`,
  };
}

describeWithDatabase("memoryRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_embedding_jobs, behavior_preferences, memory_items, audit_events,
         telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("isolates personal records by user and every record by family", async () => {
    const first = await createFamily("first");
    const second = await createFamily("second");
    await memoryRepository.create(first.owner, createInput("personal", "first-owner"));
    await memoryRepository.create(first.member, createInput("personal", "first-member"));
    await memoryRepository.create(second.owner, createInput("personal", "second-owner"));

    const visible = await memoryRepository.list(first.owner, { limit: 20 });

    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]?.author).toEqual({
      status: "current_member",
      telegramUserId: null,
      userId: first.owner.userId,
    });
  });

  it("allows only the family author or current owner to update and delete a shared record", async () => {
    const family = await createFamily("family-rights");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "family-create", "Отпуск запланирован на август"),
    );

    await expect(
      memoryRepository.update(family.owner, {
        content: "Отпуск запланирован на сентябрь",
        id: record.id,
        operationKey: "family-owner-update",
      }),
    ).resolves.toMatchObject({ content: "Отпуск запланирован на сентябрь" });

    const otherFamily = await createFamily("other-family");
    await expect(
      memoryRepository.update(otherFamily.owner, {
        content: "Чужое изменение",
        id: record.id,
        operationKey: "cross-family-update",
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);

    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [family.familyId, family.owner.userId],
    );
    await expect(
      memoryRepository.delete(family.owner, record.id, "revoked-owner-delete"),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
  });

  it("retains a family record without external identity after its author is deleted", async () => {
    const family = await createFamily("former-author");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "former-create", "Семейное правило остаётся общим"),
    );

    await database().query("DELETE FROM users WHERE id = $1", [family.member.userId]);
    const visible = await memoryRepository.list(family.owner, { limit: 20, scope: "family" });

    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]).toMatchObject({
      id: record.id,
      author: {
        status: "former_member",
        telegramUserId: null,
        userId: null,
      },
    });
  });

  it("lets a Telegram group author manage their record and rejects another participant", async () => {
    const family = await createFamily("group-rights");
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100101', 'Рабочая группа', 'external_private', 'addressed_only')
       RETURNING id`,
      [family.familyId],
    );
    const author: MemoryAuthorization = {
      familyId: family.familyId,
      groupId: group.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramUserId: "telegram-author",
      userId: null,
    };
    const stranger = { ...author, telegramUserId: "telegram-stranger" };
    const record = await memoryRepository.create(author, createInput("group", "group-create"));

    await expect(
      memoryRepository.update(stranger, {
        content: "Чужое изменение",
        id: record.id,
        operationKey: "group-stranger-update",
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
    await expect(
      memoryRepository.delete(author, record.id, "group-author-delete"),
    ).resolves.toEqual({ deleted: true });
  });

  it("returns the original record for an identical Eve replay and rejects changed input", async () => {
    const family = await createFamily("replay");
    const input = createInput("personal", "same-call");
    const first = await memoryRepository.create(family.owner, input);

    await expect(memoryRepository.create(family.owner, input)).resolves.toEqual(first);
    await expect(
      memoryRepository.create(family.owner, { ...input, content: "Подменённое значение" }),
    ).rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/);
  });

  it("enforces the configured personal quota before inserting another record", async () => {
    const family = await createFamily("quota");
    await database().query(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key)
       SELECT $1, $2, $2, $3, 'personal', 'fact', 'Факт ' || value::text,
              'test:quota', 'user_confirmed', 'normal', 'quota-' || value::text
       FROM generate_series(1, $4) AS value`,
      [family.familyId, family.owner.userId, family.owner.telegramUserId, MEMORY_SCOPE_QUOTAS.personal],
    );

    await expect(
      memoryRepository.create(family.owner, createInput("personal", "over-quota")),
    ).rejects.toThrowError(/AGENT_MEMORY_QUOTA_EXCEEDED/);
  });

  it("physically removes the memory, embedding job, and searchable content while retaining safe audit metadata", async () => {
    const family = await createFamily("delete");
    const record = await memoryRepository.create(
      family.owner,
      createInput("personal", "delete-create", "Секретное описание без учётных данных"),
    );

    await expect(
      memoryRepository.delete(family.owner, record.id, "delete-call"),
    ).resolves.toEqual({ deleted: true });
    const persisted = await database().query(
      "SELECT 1 FROM memory_items WHERE id = $1",
      [record.id],
    );
    const jobs = await database().query(
      "SELECT 1 FROM memory_embedding_jobs WHERE memory_item_id = $1",
      [record.id],
    );
    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE subject_id = $1 AND event_type = 'memory.deleted'",
      [record.id],
    );

    expect(persisted.rowCount).toBe(0);
    expect(jobs.rowCount).toBe(0);
    expect(audit.rows[0]?.metadata).not.toHaveProperty("content");
  });
});
