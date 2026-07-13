/**
 * Family task PostgreSQL authorization tests.
 *
 * Constructs covered:
 * - Personal/family destination isolation and explicit due timezone.
 * - Assignee/author/owner completion policy and replay-safe mutations.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { taskRepository } from "./task-repository.js";
import { taskManagementRepository } from "./task-management-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Задачи') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('task-owner', 'Владелец'), ('task-member', 'Участник'), ('task-other', 'Другой')
     RETURNING id, telegram_user_id`,
  );
  const id = (telegramId: string) => users.rows.find((row) => row.telegram_user_id === telegramId)!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [family.rows[0]!.id, id("task-owner"), id("task-member"), id("task-other")],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-tasks', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    memberId: id("task-member"),
    otherId: id("task-other"),
    ownerId: id("task-owner"),
  };
}

function auth(f: Awaited<ReturnType<typeof fixture>>, user: "member" | "other" | "owner", group = false) {
  const userId = user === "owner" ? f.ownerId : user === "member" ? f.memberId : f.otherId;
  return {
    familyId: f.familyId,
    groupId: group ? f.groupId : null,
    groupType: group ? "family_private" as const : null,
    messageThreadId: group ? "42" : null,
    role: user === "owner" ? "owner" as const : "member" as const,
    telegramChatId: group ? "-100-tasks" : `task-${user}`,
    telegramChatType: group ? "supergroup" as const : "private" as const,
    userId,
  };
}

describeWithDatabase("task repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE family_task_operations, family_tasks, user_notification_settings, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("creates a personal task only for the verified private-chat user", async () => {
    const f = await fixture();
    const member = auth(f, "member");
    const task = await taskRepository.create(member, {
      assigneeUserId: f.memberId,
      details: null,
      dueAt: null,
      operationKey: "personal-create",
      scope: "personal",
      timezone: null,
      title: "Позвонить врачу",
    });

    expect(task).toMatchObject({ assigneeUserId: f.memberId, scope: "personal", status: "open" });
    await expect(taskRepository.list(member)).resolves.toEqual([task]);
  });

  it("requires matching explicit notification timezone for a due task", async () => {
    const f = await fixture();
    const member = auth(f, "member");
    await database().query(
      `INSERT INTO user_notification_settings (user_id, timezone)
       VALUES ($1, 'Europe/Moscow')`,
      [f.memberId],
    );

    await expect(taskRepository.create(member, {
      assigneeUserId: f.memberId,
      details: null,
      dueAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "wrong-timezone",
      scope: "personal",
      timezone: "UTC",
      title: "Лекарство",
    })).rejects.toThrowError(/AGENT_TASK_TIMEZONE_MISMATCH/);
  });

  it("creates a family task only in its verified group for a current assignee", async () => {
    const f = await fixture();
    const task = await taskRepository.create(auth(f, "member", true), {
      assigneeUserId: f.otherId,
      details: "До вечера",
      dueAt: null,
      operationKey: "family-create",
      scope: "family",
      timezone: null,
      title: "Купить молоко",
    });

    expect(task).toMatchObject({ assigneeUserId: f.otherId, scope: "family" });
    await expect(taskRepository.list(auth(f, "other"))).resolves.toEqual([task]);
  });

  it("allows completion only by assignee, author, or owner", async () => {
    const f = await fixture();
    const task = await taskRepository.create(auth(f, "member", true), {
      assigneeUserId: f.otherId,
      details: null,
      dueAt: null,
      operationKey: "completion-create",
      scope: "family",
      timezone: null,
      title: "Забрать заказ",
    });

    await expect(taskRepository.complete(
      auth(f, "other"), task.id, "assignee-complete",
    )).resolves.toMatchObject({ status: "completed" });
  });

  it("allows only the author or owner to edit and delete a family task", async () => {
    const f = await fixture();
    const task = await taskRepository.create(auth(f, "member", true), {
      assigneeUserId: f.otherId,
      details: null,
      dueAt: null,
      operationKey: "manage-create",
      scope: "family",
      timezone: null,
      title: "Старая формулировка",
    });

    await expect(taskManagementRepository.update(auth(f, "other"), task.id, {
      details: null,
      dueAt: null,
      operationKey: "assignee-update",
      timezone: null,
      title: "Чужое изменение",
    })).rejects.toThrowError(/AGENT_TASK_MUTATION_DENIED/);
    await expect(taskManagementRepository.update(auth(f, "owner"), task.id, {
      details: "Уточнение",
      dueAt: null,
      operationKey: "owner-update",
      timezone: null,
      title: "Новая формулировка",
    })).resolves.toMatchObject({ title: "Новая формулировка" });
    await expect(taskManagementRepository.delete(
      auth(f, "member"), task.id, "author-delete",
    )).resolves.toBe(true);
  });
});
