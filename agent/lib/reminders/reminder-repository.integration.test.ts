/**
 * PostgreSQL reminder lifecycle integration tests.
 *
 * Constructs covered:
 * - Scoped settings and author-or-owner reminder mutations.
 * - Quiet-hour deferral, durable leases, recurrence, and ambiguous-delivery recovery.
 * - A list of upcoming reminders only, a delivered reminder closed for further changes, and a failed
 *   one returned to the schedule by a new time or a resume.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { encodeDateUuidCursor } from "../keyset-pagination.js";
import { reminderDispatchRepository } from "./reminder-dispatch-repository.js";
import { reminderRepository } from "./reminder-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Напоминания') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('reminder-owner', 'Владелец'), ('reminder-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "reminder-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "reminder-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-reminders', 'Семья', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

function privateAuth(fixture: Fixture, user: "member" | "owner") {
  const owner = user === "owner";
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: owner ? "owner" as const : "member" as const,
    telegramChatId: owner ? "reminder-owner" : "reminder-member",
    telegramChatType: "private" as const,
    userId: owner ? fixture.ownerId : fixture.memberId,
  };
}

function familyAuth(fixture: Fixture, user: "member" | "owner") {
  const base = privateAuth(fixture, user);
  return {
    ...base,
    groupId: fixture.groupId,
    forumTopicId: "77",
    groupType: "family_private" as const,
    messageThreadId: "77",
    telegramChatId: "-100-reminders",
    telegramChatType: "supergroup" as const,
  };
}

describeWithDatabase("reminder repositories", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE reminders, user_notification_settings, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("requires explicit valid notification settings before creating a personal reminder", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");

    await expect(reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "personal-without-settings",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    })).rejects.toThrowError(/AGENT_NOTIFICATION_SETTINGS_REQUIRED/);
    await expect(reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Not\/A-Timezone",
    })).rejects.toThrowError(/AGENT_TIMEZONE_INVALID/);

    await reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "personal-created",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    });

    expect(reminder).toMatchObject({ content: "Позвонить врачу", scope: "personal", status: "active" });
    await expect(reminderRepository.list(auth, { limit: 100 })).resolves.toEqual({
      items: [reminder],
      nextCursor: null,
    });
  });

  it("allows a family reminder to be changed only by its author or current owner", async () => {
    const fixture = await createFixture();
    const member = familyAuth(fixture, "member");
    const owner = familyAuth(fixture, "owner");
    await reminderRepository.configureNotifications(privateAuth(fixture, "member"), {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(member, {
      content: "Собрать документы",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "family-created",
      recurrence: { interval: 1, unit: "weekly" },
      scope: "family",
      timezone: "Europe/Moscow",
    });

    await expect(reminderRepository.update(owner, reminder.id, {
      content: "Собрать семейные документы",
      enabled: true,
      operationKey: "family-owner-update",
    })).resolves.toMatchObject({ content: "Собрать семейные документы" });
    await expect(reminderRepository.delete(member, reminder.id, "family-author-delete")).resolves.toBe(true);
  });

  it("replays an approved recurrence removal without a second mutation", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-08-18T07:00:00.000Z"),
      operationKey: "recurrence-created",
      recurrence: { interval: 1, unit: "daily" },
      scope: "personal",
      timezone: "Europe/Moscow",
    });
    const update = { operationKey: "recurrence-removed", recurrence: null } as const;

    const first = await reminderRepository.update(auth, reminder.id, update);
    const replay = await reminderRepository.update(auth, reminder.id, update);

    expect(first.recurrence).toBeNull();
    expect(replay).toEqual(first);
    const audits = await database().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE event_type = 'reminder.updated' AND subject_id = $1`,
      [reminder.id],
    );
    expect(audits.rows[0]?.count).toBe("1");
  });

  it("defers a due reminder through quiet hours and completes a one-time delivery", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Проверить дверь",
      firstRunAt: new Date("2026-07-12T20:30:00.000Z"),
      operationKey: "quiet-created",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    });

    await expect(reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-12T20:31:00.000Z"),
    })).resolves.toEqual([]);
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-13T04:00:00.000Z"),
    });
    expect(claimed).toMatchObject({ delayed: true, id: reminder.id, telegramChatId: "reminder-member" });

    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);
    await reminderDispatchRepository.complete(
      claimed!,
      new Date("2026-07-13T04:00:01.000Z"),
      { messageId: "601", text: "Напоминание:\n\nПроверить дверь" },
    );
    const stored = await database().query<{ status: string }>(
      "SELECT status FROM reminders WHERE id = $1",
      [reminder.id],
    );
    expect(stored.rows[0]).toEqual({ status: "completed" });
    await expect(reminderRepository.list(auth, { limit: 100 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("refuses to move, resume or pause a reminder that was already delivered", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "UTC",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Созвон в 17:00",
      firstRunAt: new Date("2026-07-12T10:00:00.000Z"),
      operationKey: "delivered-created",
      recurrence: null,
      scope: "personal",
      timezone: "UTC",
    });
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 1,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);
    await reminderDispatchRepository.complete(
      claimed!,
      new Date("2026-07-12T10:00:01.000Z"),
      { messageId: "603", text: "Напоминание:\n\nСозвон в 17:00" },
    );

    const changes = [
      { firstRunAt: new Date("2026-07-20T10:00:00.000Z"), operationKey: "delivered-move" },
      { enabled: true, operationKey: "delivered-resume" },
      { enabled: false, operationKey: "delivered-pause" },
    ];
    for (const change of changes) {
      // The model is told nothing happened and to create a new reminder, not to report a failure.
      await expect(reminderRepository.update(auth, reminder.id, change)).rejects.toMatchObject({
        code: "AGENT_REMINDER_ALREADY_DELIVERED",
        contract: { retryable: false, sideEffectStatus: "not_started" },
      });
    }
    const stored = await database().query<{ due_at: Date; status: string }>(
      "SELECT due_at, status FROM reminders WHERE id = $1",
      [reminder.id],
    );
    expect(stored.rows[0]).toEqual({
      due_at: new Date("2026-07-12T10:00:00.000Z"),
      status: "completed",
    });
    await expect(reminderRepository.delete(auth, reminder.id, "delivered-delete")).resolves.toBe(true);
  });

  it("puts a failed reminder back on schedule when it is moved or resumed", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "UTC",
    });
    const create = (operationKey: string) => reminderRepository.create(auth, {
      content: "Не дошло",
      firstRunAt: new Date("2026-07-12T10:00:00.000Z"),
      operationKey,
      recurrence: null,
      scope: "personal",
      timezone: "UTC",
    });
    const moved = await create("failed-moved-created");
    const resumed = await create("failed-resumed-created");
    await database().query(
      `UPDATE reminders
       SET status = 'failed', attempts = 3, last_error_code = 'AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED'
       WHERE id = ANY($1::uuid[])`,
      [[moved.id, resumed.id]],
    );

    await expect(reminderRepository.update(auth, moved.id, {
      firstRunAt: new Date("2026-07-20T10:00:00.000Z"),
      operationKey: "failed-move",
    })).resolves.toMatchObject({
      lastErrorCode: null,
      nextRunAt: "2026-07-20T10:00:00.000Z",
      status: "active",
    });
    await expect(reminderRepository.update(auth, resumed.id, {
      enabled: true,
      operationKey: "failed-resume",
    })).resolves.toMatchObject({ lastErrorCode: null, status: "active" });
    const attempts = await database().query<{ attempts: number }>(
      "SELECT attempts FROM reminders WHERE id = ANY($1::uuid[])",
      [[moved.id, resumed.id]],
    );
    expect(attempts.rows).toEqual([{ attempts: 0 }, { attempts: 0 }]);
  });

  it("lists only upcoming and paused reminders, soonest first", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "UTC",
    });
    const create = (content: string, firstRunAt: string, operationKey: string) =>
      reminderRepository.create(auth, {
        content,
        firstRunAt: new Date(firstRunAt),
        operationKey,
        recurrence: null,
        scope: "personal",
        timezone: "UTC",
      });
    const later = await create("Позже", "2026-07-20T10:00:00.000Z", "list-later");
    const sooner = await create("Раньше", "2026-07-15T10:00:00.000Z", "list-sooner");
    const paused = await create("На паузе", "2026-07-25T10:00:00.000Z", "list-paused");
    await reminderRepository.update(auth, paused.id, { enabled: false, operationKey: "list-pause" });
    const delivered = await create("Отправлено", "2026-07-10T10:00:00.000Z", "list-delivered");
    const failed = await create("Не дошло", "2026-07-11T10:00:00.000Z", "list-failed");
    await database().query("UPDATE reminders SET status = 'completed' WHERE id = $1", [delivered.id]);
    await database().query(
      "UPDATE reminders SET status = 'failed', last_error_code = 'AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED' WHERE id = $1",
      [failed.id],
    );

    const listed = await reminderRepository.list(auth, { limit: 100 });

    expect(listed.items.map((item) => item.id)).toEqual([sooner.id, later.id, paused.id]);
  });

  it("advances recurring wall-clock time across DST and skips missed occurrences", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Berlin",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Утреннее лекарство",
      firstRunAt: new Date("2026-03-28T08:00:00.000Z"),
      operationKey: "dst-created",
      recurrence: { interval: 1, unit: "daily" },
      scope: "personal",
      timezone: "Europe/Berlin",
    });
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 1,
      now: new Date("2026-03-28T08:00:00.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);
    await reminderDispatchRepository.complete(
      claimed!,
      new Date("2026-03-28T08:01:00.000Z"),
      { messageId: "602", text: "Напоминание:\n\nУтреннее лекарство" },
    );

    const { items: [stored] } = await reminderRepository.list(auth, { limit: 100 });
    expect(stored).toMatchObject({ id: reminder.id, nextRunAt: "2026-03-29T07:00:00.000Z", status: "active" });
  });

  it("does not retry an expired lease after Telegram dispatch may have started", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "UTC",
    });
    await reminderRepository.create(auth, {
      content: "Не продублировать",
      firstRunAt: new Date("2026-07-12T10:00:00.000Z"),
      operationKey: "ambiguous-created",
      recurrence: null,
      scope: "personal",
      timezone: "UTC",
    });
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);

    await expect(reminderDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-12T10:00:02.000Z"),
    })).resolves.toEqual([]);
    const stored = await database().query<{ last_error_code: string; status: string }>(
      "SELECT last_error_code, status FROM reminders WHERE id = $1",
      [claimed!.id],
    );
    expect(stored.rows[0]).toEqual({
      last_error_code: "AGENT_REMINDER_DELIVERY_AMBIGUOUS",
      status: "failed",
    });
  });

  it("paginates more than 100 active reminders without duplicates or skipped timestamp ties", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO reminders
         (family_id, owner_user_id, author_user_id, scope, content, timezone, telegram_chat_id,
          recurrence_anchor_local, due_at, available_at, created_at)
       SELECT $1, $2, $2, 'personal', 'Напоминание ' || item, 'UTC', 'reminder-member',
              timestamp '2026-01-01 00:00:00', timestamptz '2026-01-01 00:00:00+00',
              timestamptz '2026-01-01 00:00:00+00',
              timestamptz '2026-02-01 00:00:00+00'
         FROM generate_series(1, 102) AS item
       RETURNING id`,
      [fixture.familyId, fixture.memberId],
    );

    const first = await reminderRepository.list(auth, { limit: 100 });
    const second = await reminderRepository.list(auth, { cursor: first.nextCursor!, limit: 100 });
    const ids = [...first.items, ...second.items].map((item) => item.id);

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(ids).toHaveLength(102);
    expect(new Set(ids)).toHaveLength(102);
    expect(new Set(ids)).toEqual(new Set(inserted.rows.map((row) => row.id)));
    await expect(reminderRepository.list(auth, { cursor: "invalid", limit: 100 }))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_CURSOR_INVALID" });
    // A cursor issued before the list was ordered by due time carries no binding and is refused
    // rather than silently read as a position in the new order.
    const unbound = encodeDateUuidCursor(new Date("2026-02-01T00:00:00.000Z"), inserted.rows[0]!.id);
    await expect(reminderRepository.list(auth, { cursor: unbound, limit: 100 }))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_CURSOR_INVALID" });
  });
});
