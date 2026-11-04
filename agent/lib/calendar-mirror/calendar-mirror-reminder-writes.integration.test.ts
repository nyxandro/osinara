/**
 * PostgreSQL tests of reminder changes coming from Google Calendar.
 *
 * Constructs covered:
 * - Deleting a copy in Google deletes the reminder; a reminder being delivered waits for the next minute.
 * - Moving, renaming and re-repeating a copy changes the reminder; a series moved into the past
 *   continues from its next run; a one-time copy moved into the past is refused.
 * - A person's own event becomes a personal or family reminder exactly once and is linked to it;
 *   without a timezone or in the past it is not created.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { CalendarMirrorActor, CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";
import {
  applyCalendarEdit,
  createReminderFromEvent,
  deleteReminderFromCalendar,
} from "./calendar-mirror-reminder-writes.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const NOW = new Date("2027-02-03T09:00:00Z");

interface Fixture {
  actor: CalendarMirrorActor;
  familyId: string;
  familyProfile: CalendarMirrorProfile;
  groupId: string;
  ownerId: string;
  personalProfile: CalendarMirrorProfile;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Правки') RETURNING id");
  const familyId = family.rows[0]!.id;
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('writes-owner', 'Владелец') RETURNING id",
  );
  const ownerId = owner.rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, ownerId]);
  await database().query(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, created_at)
     VALUES ($1, '-100-later', 'Поздняя', 'family_private', 'addressed_only', now()),
            ($1, '-100-first', 'Первая', 'family_private', 'addressed_only', now() - interval '1 day')`,
    [familyId],
  );
  const group = await database().query<{ id: string }>("SELECT id FROM telegram_groups WHERE telegram_chat_id = '-100-first'");
  const personal = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, owner_user_id, scope) VALUES ($1, $2, 'personal') RETURNING id",
    [familyId, ownerId],
  );
  const familyWorkspace = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, scope) VALUES ($1, 'family') RETURNING id",
    [familyId],
  );
  for (const workspaceId of [personal.rows[0]!.id, familyWorkspace.rows[0]!.id]) {
    await database().query("INSERT INTO calendar_mirror_profiles (workspace_id) VALUES ($1)", [workspaceId]);
  }
  await database().query(
    "INSERT INTO user_notification_settings (user_id, timezone, timezone_source, timezone_set_at) VALUES ($1, 'Europe/Moscow', 'person', now())",
    [ownerId],
  );
  return {
    actor: { role: "owner", telegramUserId: "writes-owner", userId: ownerId },
    familyId,
    familyProfile: (await calendarMirrorRepository.profile(familyWorkspace.rows[0]!.id))!,
    groupId: group.rows[0]!.id,
    ownerId,
    personalProfile: (await calendarMirrorRepository.profile(personal.rows[0]!.id))!,
  };
}

async function personalReminder(fixture: Fixture, input: { status?: string; unit?: string } = {}) {
  const reminder = await database().query<{ id: string }>(
    `INSERT INTO reminders
       (family_id, owner_user_id, author_user_id, scope, content, timezone, telegram_chat_id,
        recurrence_unit, recurrence_interval, recurrence_anchor_local, due_at, available_at, status,
        lease_token, lease_expires_at)
     VALUES ($1, $2, $2, 'personal', $3, 'Europe/Moscow', 'writes-owner', $4::reminder_recurrence_unit, $5,
             '2027-02-05 10:00', '2027-02-05T07:00:00Z', '2027-02-05T07:00:00Z', $6::reminder_status,
             CASE WHEN $6 = 'leased' THEN gen_random_uuid() END,
             CASE WHEN $6 = 'leased' THEN now() + interval '5 minutes' END)
     RETURNING id`,
    [fixture.familyId, fixture.ownerId, "Позвонить в банк\nНомер в заметках", input.unit ?? null, input.unit ? 1 : null, input.status ?? "active"],
  );
  const reminderId = reminder.rows[0]!.id;
  const copy = await calendarMirrorRepository.insertPendingCopy(fixture.personalProfile.workspaceId, reminderId, `osr${reminderId.replaceAll("-", "")}`);
  return { copyId: copy.id, reminderId };
}

async function reminderRow(id: string) {
  const result = await database().query<{
    anchor: string; content: string; due_at: Date; recurrence_interval: number | null; recurrence_unit: string | null;
  }>(
    `SELECT content, due_at, recurrence_unit::text AS recurrence_unit, recurrence_interval,
            to_char(recurrence_anchor_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS anchor
     FROM reminders WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

describeWithDatabase("calendar mirror reminder writes", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE calendar_mirror_copies, calendar_mirror_profiles, reminders, user_notification_settings,
                telegram_groups, workspaces, family_memberships, users, families, audit_events CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("deletes a reminder deleted in Google, but not while it is being delivered", async () => {
    const fixture = await createFixture();
    const leased = await personalReminder(fixture, { status: "leased" });
    expect(await deleteReminderFromCalendar({ actorUserId: fixture.ownerId, copyId: leased.copyId, familyId: fixture.familyId, reminderId: leased.reminderId }))
      .toBe("busy");
    expect(await reminderRow(leased.reminderId)).toBeDefined();

    const active = await personalReminder(fixture);
    expect(await deleteReminderFromCalendar({ actorUserId: fixture.ownerId, copyId: active.copyId, familyId: fixture.familyId, reminderId: active.reminderId }))
      .toBe("deleted");
    expect(await reminderRow(active.reminderId)).toBeUndefined();
    const copies = await calendarMirrorRepository.copies(fixture.personalProfile.workspaceId);
    expect(copies.map((copy) => copy.id)).toEqual([leased.copyId]);
    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE event_type = 'reminder.deleted' AND subject_id = $1",
      [active.reminderId],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ source: "google_calendar" });
  });

  it("moves and renames a reminder changed in Google and keeps the event version it saw", async () => {
    const fixture = await createFixture();
    const { copyId, reminderId } = await personalReminder(fixture);
    const result = await applyCalendarEdit({
      actorUserId: fixture.ownerId,
      copyId,
      edit: {
        content: "Позвонить в банк до обеда\nНомер в заметках",
        schedule: { recurrence: null, startLocal: "2027-02-06T12:00:00" },
      },
      etag: "\"person-1\"",
      eventUpdated: new Date("2027-02-03T08:59:00Z"),
      familyId: fixture.familyId,
      now: NOW,
      reminderId,
    });
    expect(result).toBe("applied");
    expect(await reminderRow(reminderId)).toMatchObject({
      anchor: "2027-02-06T12:00:00",
      content: "Позвонить в банк до обеда\nНомер в заметках",
      due_at: new Date("2027-02-06T09:00:00Z"),
      recurrence_unit: null,
    });
    const [copy] = await calendarMirrorRepository.copies(fixture.personalProfile.workspaceId);
    expect(copy).toMatchObject({ etag: "\"person-1\"" });
  });

  it("continues a series moved into the past from its next run", async () => {
    const fixture = await createFixture();
    const { copyId, reminderId } = await personalReminder(fixture, { unit: "weekly" });
    const result = await applyCalendarEdit({
      actorUserId: fixture.ownerId,
      copyId,
      edit: {
        schedule: {
          recurrence: { anchorDay: 1, anchorMonth: 2, recurrence: { interval: 1, unit: "weekly" } },
          startLocal: "2027-02-01T11:00:00",
        },
      },
      etag: "\"person-2\"",
      eventUpdated: null,
      familyId: fixture.familyId,
      now: NOW,
      reminderId,
    });
    expect(result).toBe("applied");
    expect(await reminderRow(reminderId)).toMatchObject({
      anchor: "2027-02-01T11:00:00",
      due_at: new Date("2027-02-08T08:00:00Z"),
      recurrence_interval: 1,
      recurrence_unit: "weekly",
    });
  });

  it("anchors a «last day of the month» series at a day 31", async () => {
    const fixture = await createFixture();
    const { copyId, reminderId } = await personalReminder(fixture, { unit: "monthly" });
    await applyCalendarEdit({
      actorUserId: fixture.ownerId,
      copyId,
      edit: {
        schedule: {
          recurrence: { anchorDay: 31, anchorMonth: 2, recurrence: { interval: 1, unit: "monthly" } },
          startLocal: "2027-02-28T10:00:00",
        },
      },
      etag: "\"person-3\"",
      eventUpdated: null,
      familyId: fixture.familyId,
      now: NOW,
      reminderId,
    });
    expect(await reminderRow(reminderId)).toMatchObject({
      anchor: "2027-01-31T10:00:00",
      due_at: new Date("2027-02-28T07:00:00Z"),
      recurrence_unit: "monthly",
    });
  });

  it("refuses a one-time copy moved into the past and leaves delivered and missing reminders alone", async () => {
    const fixture = await createFixture();
    const { copyId, reminderId } = await personalReminder(fixture);
    const base = { actorUserId: fixture.ownerId, copyId, etag: "\"e\"", eventUpdated: null, familyId: fixture.familyId, now: NOW };
    expect(await applyCalendarEdit({ ...base, edit: { schedule: { recurrence: null, startLocal: "2027-02-02T10:00:00" } }, reminderId }))
      .toEqual({ unsupported: "past" });
    expect((await reminderRow(reminderId))!.due_at).toEqual(new Date("2027-02-05T07:00:00Z"));

    const delivered = await personalReminder(fixture, { status: "completed" });
    expect(await applyCalendarEdit({ ...base, copyId: delivered.copyId, edit: { content: "x" }, reminderId: delivered.reminderId }))
      .toBe("delivered");
    expect(await applyCalendarEdit({ ...base, edit: { content: "x" }, reminderId: "00000000-0000-4000-8000-000000000000" }))
      .toBe("missing");
  });

  it("makes a person's own event a personal reminder once and links the event to it", async () => {
    const fixture = await createFixture();
    const input = {
      actor: fixture.actor,
      content: "Купить хлеб",
      etag: "\"own-1\"",
      eventId: "personevent01",
      eventUpdated: null,
      now: NOW,
      profile: fixture.personalProfile,
      recurrence: null,
      start: { instant: new Date("2027-02-04T15:00:00Z") },
    };
    const created = await createReminderFromEvent(input);
    expect(created).toEqual({ reminderId: expect.any(String) });
    const reminderId = (created as { reminderId: string }).reminderId;
    const row = await database().query<{ scope: string; telegram_chat_id: string; timezone: string }>(
      "SELECT scope::text AS scope, telegram_chat_id, timezone FROM reminders WHERE id = $1",
      [reminderId],
    );
    expect(row.rows[0]).toEqual({ scope: "personal", telegram_chat_id: "writes-owner", timezone: "Europe/Moscow" });
    expect(await calendarMirrorRepository.copies(fixture.personalProfile.workspaceId)).toEqual([
      expect.objectContaining({ etag: "\"own-1\"", eventId: "personevent01", kind: "copy", reminderId }),
    ]);
    expect(await createReminderFromEvent(input)).toEqual({ reminderId });
    expect((await database().query("SELECT 1 FROM reminders")).rowCount).toBe(1);
  });

  it("sends a family event to the earliest family group, an all-day one at nine", async () => {
    const fixture = await createFixture();
    const created = await createReminderFromEvent({
      actor: fixture.actor,
      content: "День рождения мамы",
      etag: "\"own-2\"",
      eventId: "familyevent01",
      eventUpdated: null,
      now: NOW,
      profile: fixture.familyProfile,
      recurrence: { anchorDay: 10, anchorMonth: 3, recurrence: { interval: 1, unit: "yearly" } },
      start: { allDayDate: "2026-03-10" },
    }) as { reminderId: string };
    const row = await database().query<{ due_at: Date; group_id: string; scope: string; telegram_chat_id: string }>(
      "SELECT scope::text AS scope, group_id, telegram_chat_id, due_at FROM reminders WHERE id = $1",
      [created.reminderId],
    );
    expect(row.rows[0]).toEqual({
      due_at: new Date("2027-03-10T06:00:00Z"),
      group_id: fixture.groupId,
      scope: "family",
      telegram_chat_id: "-100-first",
    });
  });

  it("creates nothing without the author's timezone or for a one-time event in the past", async () => {
    const fixture = await createFixture();
    const base = {
      actor: fixture.actor,
      content: "Купить хлеб",
      etag: "\"own-3\"",
      eventUpdated: null,
      now: NOW,
      profile: fixture.personalProfile,
      recurrence: null,
    };
    expect(await createReminderFromEvent({ ...base, eventId: "pastevent0001", start: { instant: new Date("2027-02-01T10:00:00Z") } }))
      .toBe("past");
    await database().query("DELETE FROM user_notification_settings");
    expect(await createReminderFromEvent({ ...base, eventId: "nosettings001", start: { instant: new Date("2027-02-04T10:00:00Z") } }))
      .toBe("settings_missing");
    expect((await database().query("SELECT 1 FROM reminders")).rowCount).toBe(0);
  });
});
