/**
 * Telegram external-group policy update PostgreSQL integration tests.
 *
 * Constructs covered:
 * - `updatePolicy`: atomically changes only message mode and the complete tool allowlist.
 * - The canonical external group type is supported, while an absent registration is never created.
 * - Existing group identity, metadata, timeline, workspace, memory, and sessions remain attached.
 * - Family trust zones and callers whose owner role was revoked are rejected transactionally.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { stopSandbox } = vi.hoisted(() => ({ stopSandbox: vi.fn() }));
vi.mock("./sandbox-runner/runner-client.js", () => ({
  SandboxRunnerClient: class { stop = stopSandbox; },
}));

import { closeDatabase, database } from "./database.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function ownedFamily() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Policy update') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('policy-owner', 'Владелец') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, ownerId: owner.rows[0]!.id };
}

describeWithDatabase("Telegram group policy update repository", () => {
  beforeEach(async () => {
    stopSandbox.mockReset().mockResolvedValue(undefined);
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("preserves all external-group scoped data while replacing the complete policy", async () => {
    const fixture = await ownedFamily();
    const group = await database().query<{ created_at: Date; id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, next_timeline_sequence)
       VALUES ($1, '-100-policy', 'Неизменное название', 'external', 'addressed_only',
               ARRAY['remember'], 1)
       RETURNING id, created_at`,
      [fixture.familyId],
    );
    const groupId = group.rows[0]!.id;

    // Seed every group-owned durable boundary that a delete/re-register implementation would damage.
    const session = await database().query<{ id: string; thread_id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
           continuation_token, agent_session_id, started_at, last_activity_at, group_timeline_cursor)
       VALUES (gen_random_uuid(), 0, $1, $2, 'group', 'canonical', '-100-policy::', '-100-policy::',
               'wrun_policy', now(), now(), 1)
        RETURNING id, thread_id`,
      [fixture.familyId, groupId],
    );
    const timeline = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, sequence_id, actor_kind, actor_id, telegram_message_id, telegram_user_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at, application_session_id)
       VALUES ($1, 1, 'user', 'telegram:policy-owner', 101, 'policy-owner', 'Владелец', false,
               'text', 'Сохранённая история', now(), $2)
       RETURNING id`,
      [groupId, session.rows[0]!.id],
    );
    const workspace = await database().query<{ id: string }>(
      `INSERT INTO workspaces (family_id, group_id, scope)
       VALUES ($1, $2, 'group') RETURNING id`,
      [fixture.familyId, groupId],
    );
    const memory = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, group_id, scope, author_telegram_user_id, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'group', 'policy-owner', 'fact', 'Сохранённая память', 'test',
               'user_confirmed', 'normal', 'policy-memory')
       RETURNING id`,
      [fixture.familyId, groupId],
    );

    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId,
      messageMode: "owner_only",
      requestedBy: fixture.ownerId,
      telegramChatId: "-100-policy",
      toolAllowlist: ["list_group_history", "search_memories"],
    })).resolves.toEqual({ groupId, skillsNeedBash: false });
    expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(session.rows[0]!.thread_id);

    const persistedGroup = await database().query(
      `SELECT id, title, type::text, message_mode::text, tool_allowlist, created_at
       FROM telegram_groups WHERE id = $1`,
      [groupId],
    );
    expect(persistedGroup.rows[0]).toEqual({
      created_at: group.rows[0]!.created_at,
      id: groupId,
      message_mode: "owner_only",
      title: "Неизменное название",
      tool_allowlist: ["list_group_history", "search_memories"],
      type: "external",
    });

    // Stable primary keys prove that no scoped row was deleted and recreated behind the update.
    for (const [table, id] of [
      ["telegram_group_messages", timeline.rows[0]!.id],
      ["workspaces", workspace.rows[0]!.id],
      ["memory_items", memory.rows[0]!.id],
      ["conversation_sessions", session.rows[0]!.id],
    ] as const) {
      await expect(database().query(`SELECT id FROM ${table} WHERE id = $1`, [id])).resolves.toMatchObject({
        rowCount: 1,
      });
    }

    stopSandbox.mockRejectedValueOnce(new Error("TEST_RUNNER_UNAVAILABLE"));
    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId, requestedBy: fixture.ownerId, telegramChatId: "-100-policy",
      messageMode: "all", toolAllowlist: [],
    })).rejects.toThrow("TEST_RUNNER_UNAVAILABLE");
    expect((await database().query(
      "SELECT message_mode,tool_allowlist FROM telegram_groups WHERE id=$1", [groupId],
    )).rows).toEqual([{ message_mode: "owner_only", tool_allowlist: ["list_group_history", "search_memories"] }]);
  });

  it("rejects a family group without changing its policy", async () => {
    const fixture = await ownedFamily();
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-family-policy', 'Семья', 'family_private', 'addressed_only', '{}')`,
      [fixture.familyId],
    );

    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId,
      messageMode: "all",
      requestedBy: fixture.ownerId,
      telegramChatId: "-100-family-policy",
      toolAllowlist: ["remember"],
    })).rejects.toThrowError(/AGENT_GROUP_POLICY_UPDATE_UNSUPPORTED/);
    await expect(database().query(
      `SELECT message_mode::text, tool_allowlist
       FROM telegram_groups WHERE telegram_chat_id = '-100-family-policy'`,
    )).resolves.toMatchObject({
      rows: [{ message_mode: "addressed_only", tool_allowlist: [] }],
    });
  });

  it("updates an existing external group in place", async () => {
    const fixture = await ownedFamily();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-public-policy', 'Внешняя', 'external', 'all', '{}')
       RETURNING id`,
      [fixture.familyId],
    );

    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId,
      messageMode: "addressed_only",
      requestedBy: fixture.ownerId,
      telegramChatId: "-100-public-policy",
      toolAllowlist: ["remember"],
    })).resolves.toEqual({ groupId: group.rows[0]!.id, skillsNeedBash: false });
    await expect(database().query(
      "SELECT message_mode::text, tool_allowlist FROM telegram_groups WHERE id = $1",
      [group.rows[0]!.id],
    )).resolves.toMatchObject({
      rows: [{ message_mode: "addressed_only", tool_allowlist: ["remember"] }],
    });
  });

  it("rejects an absent group instead of registering it", async () => {
    const fixture = await ownedFamily();

    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId,
      messageMode: "all",
      requestedBy: fixture.ownerId,
      telegramChatId: "-100-missing-policy",
      toolAllowlist: [],
    })).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/);
    await expect(database().query(
      "SELECT 1 FROM telegram_groups WHERE telegram_chat_id = '-100-missing-policy'",
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rechecks the current owner role inside the update transaction", async () => {
    const fixture = await ownedFamily();
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-revoked-policy', 'Внешняя', 'external', 'all', '{}')`,
      [fixture.familyId],
    );
    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.ownerId],
    );

    await expect(telegramGroupAdministrationRepository.updatePolicy({
      familyId: fixture.familyId,
      messageMode: "owner_only",
      requestedBy: fixture.ownerId,
      telegramChatId: "-100-revoked-policy",
      toolAllowlist: [],
    })).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
  });
});
