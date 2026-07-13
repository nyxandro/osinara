/**
 * Family task overdue dispatch integration tests.
 *
 * Constructs covered:
 * - Twenty-four-hour threshold, assignee quiet hours, leases, and terminal ambiguity.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { taskOverdueRepository } from "./task-overdue-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function seedTask() {
  const result = await database().query<{
    family_id: string;
    task_id: string;
    user_id: string;
  }>(
    `WITH family AS (
       INSERT INTO families (name) VALUES ('Просрочка') RETURNING id
     ), user_row AS (
       INSERT INTO users (telegram_user_id, display_name)
       VALUES ('overdue-user', 'Исполнитель') RETURNING id
     ), membership AS (
       INSERT INTO family_memberships (family_id, user_id, role)
       SELECT family.id, user_row.id, 'owner' FROM family, user_row
     ), settings AS (
       INSERT INTO user_notification_settings (user_id, timezone, quiet_start, quiet_end)
       SELECT id, 'Europe/Moscow', '23:00', '07:00' FROM user_row
     ), group_row AS (
       INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       SELECT id, '-100-overdue', 'Семья', 'family_private', 'addressed_only' FROM family
       RETURNING id, family_id
     )
     INSERT INTO family_tasks
       (family_id, author_user_id, assignee_user_id, group_id, scope, title,
        due_at, timezone, telegram_chat_id, message_thread_id, overdue_available_at)
     SELECT group_row.family_id, user_row.id, user_row.id, group_row.id, 'family',
            'Забрать заказ', '2026-07-11T20:30:00Z', 'Europe/Moscow', '-100-overdue', 42,
            '2026-07-12T20:30:00Z'
     FROM group_row, user_row
     RETURNING id AS task_id, family_id, assignee_user_id AS user_id`,
  );
  return result.rows[0]!;
}

describeWithDatabase("task overdue repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE family_tasks, user_notification_settings, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("defers through quiet hours and completes one overdue notification", async () => {
    const task = await seedTask();
    await expect(taskOverdueRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-12T20:31:00Z"),
    })).resolves.toEqual([]);
    const [claim] = await taskOverdueRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-13T04:00:00Z"),
    });
    expect(claim).toMatchObject({
      id: task.task_id,
      messageThreadId: "42",
      telegramChatId: "-100-overdue",
      title: "Забрать заказ",
    });
    await taskOverdueRepository.markDispatchStarted(claim!.id, claim!.leaseToken);
    await taskOverdueRepository.complete(claim!);
    await expect(taskOverdueRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-13T04:01:00Z"),
    })).resolves.toEqual([]);
  });

  it("fails closed after an expired lease whose delivery started", async () => {
    const task = await seedTask();
    const [claim] = await taskOverdueRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-13T04:00:00Z"),
    });
    await taskOverdueRepository.markDispatchStarted(claim!.id, claim!.leaseToken);
    await taskOverdueRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-13T04:00:02Z"),
    });
    const stored = await database().query<{ overdue_error_code: string }>(
      "SELECT overdue_error_code FROM family_tasks WHERE id = $1",
      [task.task_id],
    );
    expect(stored.rows[0]?.overdue_error_code).toBe("AGENT_TASK_OVERDUE_DELIVERY_AMBIGUOUS");
  });
});
