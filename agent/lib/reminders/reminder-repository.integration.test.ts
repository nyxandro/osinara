/**
 * PostgreSQL reminder lifecycle integration tests.
 *
 * Constructs covered:
 * - Scoped settings and author-or-owner reminder mutations.
 * - Quiet-hour deferral, durable leases, recurrence, and ambiguous-delivery recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
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
    await expect(reminderRepository.list(auth)).resolves.toEqual([reminder]);
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
    await expect(reminderRepository.list(auth)).resolves.toEqual([
      expect.objectContaining({ id: reminder.id, status: "completed" }),
    ]);
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

    const [stored] = await reminderRepository.list(auth);
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
    await expect(reminderRepository.list(auth)).resolves.toEqual([
      expect.objectContaining({ lastErrorCode: "AGENT_REMINDER_DELIVERY_AMBIGUOUS", status: "failed" }),
    ]);
  });
});
