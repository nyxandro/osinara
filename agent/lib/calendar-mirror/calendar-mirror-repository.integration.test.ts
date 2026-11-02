/**
 * PostgreSQL tests of the reminder ↔ Google Calendar mirror state.
 *
 * Constructs covered:
 * - A personal profile mirrors only its owner's personal reminders; the family profile only the
 *   family's; external-group reminders never.
 * - Reconnecting the same Google account keeps the calendar and its copies; another account resets them.
 * - Due profiles carry the member they act for and skip stopped, deferred and disconnected ones.
 * - A deleted reminder leaves its copy for removal; a stop tells the person exactly once.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  familyWorkspaceId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
  personalWorkspaceId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Календарь') RETURNING id");
  const familyId = family.rows[0]!.id;
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('mirror-owner', 'Владелец'), ('mirror-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "mirror-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "mirror-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [familyId, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-mirror', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [familyId],
  );
  const personal = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, owner_user_id, scope) VALUES ($1, $2, 'personal') RETURNING id",
    [familyId, ownerId],
  );
  const familyWorkspace = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, scope) VALUES ($1, 'family') RETURNING id",
    [familyId],
  );
  await database().query(
    `INSERT INTO user_notification_settings (user_id, timezone, quiet_start, quiet_end)
     VALUES ($1, 'Europe/Moscow', '23:00', '08:00'), ($2, 'Europe/Moscow', NULL, NULL)`,
    [ownerId, memberId],
  );
  return {
    familyId,
    familyWorkspaceId: familyWorkspace.rows[0]!.id,
    groupId: group.rows[0]!.id,
    memberId,
    ownerId,
    personalWorkspaceId: personal.rows[0]!.id,
  };
}

async function connectGoogle(fixture: Fixture, workspaceId: string, externalAccountId: string): Promise<string> {
  const account = await database().query<{ id: string }>(
    `INSERT INTO integration_accounts
       (family_id, connected_by_user_id, workspace_id, provider, external_account_id, display_name,
        status, scopes, is_default)
     VALUES ($1, $2, $3, 'google_workspace', $4, 'owner@example.com', 'active', ARRAY['scope'], true)
     RETURNING id`,
    [fixture.familyId, fixture.ownerId, workspaceId, externalAccountId],
  );
  const accountId = account.rows[0]!.id;
  await calendarMirrorRepository.applyConnection(database(), {
    externalAccountId,
    integrationAccountId: accountId,
    workspaceId,
  });
  return accountId;
}

async function insertReminder(fixture: Fixture, input: {
  content: string;
  scope: "family" | "group" | "personal";
  status?: string;
  unit?: string;
  userId?: string;
}): Promise<string> {
  const personal = input.scope === "personal";
  const group = input.scope === "group";
  const author = input.userId ?? fixture.ownerId;
  const result = await database().query<{ id: string }>(
    `INSERT INTO reminders
       (family_id, owner_user_id, author_user_id, author_telegram_user_id, group_id, scope, content,
        timezone, telegram_chat_id, recurrence_unit, recurrence_interval, recurrence_anchor_local,
        recurrence_anchor_at, due_at, available_at, status)
     VALUES ($1, $2, $3, $4, $5, $6::reminder_scope, $7, 'Europe/Moscow', $8, $9::reminder_recurrence_unit,
             $10, '2099-03-01 10:00', '2099-03-01T07:00:00Z', '2099-03-01T07:00:00Z', '2099-03-01T07:00:00Z',
             $11::reminder_status)
     RETURNING id`,
    [
      fixture.familyId,
      personal ? author : null,
      group ? null : author,
      group ? "external-author" : null,
      personal ? null : fixture.groupId,
      input.scope,
      input.content,
      personal ? "mirror-owner" : "-100-mirror",
      input.unit ?? null,
      input.unit ? 1 : null,
      input.status ?? "active",
    ],
  );
  return result.rows[0]!.id;
}

describeWithDatabase("calendar mirror repository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE calendar_mirror_copies, calendar_mirror_profiles, reminders, integration_credentials,
                integration_accounts, user_notification_settings, telegram_groups, workspaces,
                family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("selects only the reminders each profile mirrors", async () => {
    const fixture = await createFixture();
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    await connectGoogle(fixture, fixture.familyWorkspaceId, "google-family");
    const ownPersonal = await insertReminder(fixture, { content: "Позвонить в банк", scope: "personal" });
    await insertReminder(fixture, { content: "Чужое личное", scope: "personal", userId: fixture.memberId });
    const familyReminder = await insertReminder(fixture, { content: "Дача", scope: "family", userId: fixture.memberId });
    await insertReminder(fixture, { content: "Внешняя группа", scope: "group" });
    await insertReminder(fixture, { content: "Уже отправлено", scope: "personal", status: "completed" });

    const personal = await calendarMirrorRepository.profile(fixture.personalWorkspaceId);
    const family = await calendarMirrorRepository.profile(fixture.familyWorkspaceId);
    const personalReminders = await calendarMirrorRepository.mirrorReminders(personal!);
    const familyReminders = await calendarMirrorRepository.mirrorReminders(family!);

    expect(personalReminders.map((reminder) => reminder.id)).toEqual([ownPersonal]);
    expect(personalReminders[0]).toMatchObject({
      anchorLocal: "2099-03-01T10:00:00",
      dueLocal: "2099-03-01T10:00:00",
      quiet: { end: "08:00:00", start: "23:00:00" },
      recurrence: null,
      timezone: "Europe/Moscow",
    });
    expect(familyReminders.map((reminder) => reminder.id)).toEqual([familyReminder]);
    expect(familyReminders[0]!.quiet).toBeNull();
  });

  it("keeps the calendar for the same account and resets it for another", async () => {
    const fixture = await createFixture();
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    const reminderId = await insertReminder(fixture, { content: "Позвонить в банк", scope: "personal" });
    await calendarMirrorRepository.setCalendar(fixture.personalWorkspaceId, "calendar-1@group.calendar.google.com");
    await calendarMirrorRepository.setSyncToken(fixture.personalWorkspaceId, "sync-1");
    await calendarMirrorRepository.insertPendingCopy(fixture.personalWorkspaceId, reminderId, "osrabcdef");
    expect(await calendarMirrorRepository.stop(fixture.personalWorkspaceId, "stopped_access_lost", "AGENT_GOOGLE_AUTH_EXPIRED")).toBe(true);

    await database().query("DELETE FROM integration_accounts WHERE workspace_id = $1", [fixture.personalWorkspaceId]);
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    const same = await calendarMirrorRepository.profile(fixture.personalWorkspaceId);
    expect(same).toMatchObject({
      calendarId: "calendar-1@group.calendar.google.com",
      state: "active",
      stopNoticeAt: null,
      syncToken: "sync-1",
    });
    expect(await calendarMirrorRepository.copies(fixture.personalWorkspaceId)).toHaveLength(1);

    await database().query("DELETE FROM integration_accounts WHERE workspace_id = $1", [fixture.personalWorkspaceId]);
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-other");
    const other = await calendarMirrorRepository.profile(fixture.personalWorkspaceId);
    expect(other).toMatchObject({ calendarId: null, calendarMarker: null, syncToken: null, state: "active" });
    expect(await calendarMirrorRepository.copies(fixture.personalWorkspaceId)).toEqual([]);
  });

  it("returns due profiles with the member they act for", async () => {
    const fixture = await createFixture();
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    await connectGoogle(fixture, fixture.familyWorkspaceId, "google-family");
    const now = new Date("2099-01-01T00:00:00Z");

    const due = await calendarMirrorRepository.dueProfiles(now);
    expect(due.map(({ actor, profile }) => [profile.scope, actor?.userId])).toEqual(
      expect.arrayContaining([["personal", fixture.ownerId], ["family", fixture.ownerId]]),
    );
    expect(due.find(({ profile }) => profile.scope === "family")!.actor).toEqual({
      role: "owner",
      telegramUserId: "mirror-owner",
      userId: fixture.ownerId,
    });

    await calendarMirrorRepository.deferUntil(fixture.personalWorkspaceId, new Date("2099-01-01T00:05:00Z"));
    await calendarMirrorRepository.stop(fixture.familyWorkspaceId, "stopped_calendar_deleted", "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED");
    expect(await calendarMirrorRepository.dueProfiles(now)).toEqual([]);
    expect((await calendarMirrorRepository.dueProfiles(new Date("2099-01-01T00:05:00Z"))).map(({ profile }) => profile.scope))
      .toEqual(["personal"]);

    await database().query("DELETE FROM integration_accounts WHERE workspace_id = $1", [fixture.personalWorkspaceId]);
    expect(await calendarMirrorRepository.dueProfiles(new Date("2099-01-01T00:05:00Z"))).toEqual([]);
  });

  it("leaves the copy of a deleted reminder for removal and tells about a stop once", async () => {
    const fixture = await createFixture();
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    const reminderId = await insertReminder(fixture, { content: "Позвонить в банк", scope: "personal" });
    const copy = await calendarMirrorRepository.insertPendingCopy(fixture.personalWorkspaceId, reminderId, "osrabcdef");
    await database().query("DELETE FROM reminders WHERE id = $1", [reminderId]);

    const [orphan] = await calendarMirrorRepository.copies(fixture.personalWorkspaceId);
    expect(orphan).toMatchObject({ id: copy.id, kind: "copy", reminderId: null });

    expect(await calendarMirrorRepository.stop(fixture.personalWorkspaceId, "stopped_access_lost", "AGENT_GOOGLE_AUTH_EXPIRED")).toBe(true);
    expect(await calendarMirrorRepository.stop(fixture.personalWorkspaceId, "stopped_access_lost", "AGENT_GOOGLE_AUTH_EXPIRED")).toBe(false);
  });

  it("puts a profile left removing by a dead disconnect back to work", async () => {
    const fixture = await createFixture();
    await connectGoogle(fixture, fixture.personalWorkspaceId, "google-owner");
    await calendarMirrorRepository.markRemoving(fixture.personalWorkspaceId);
    await calendarMirrorRepository.releaseStaleRemoving(new Date(), 10);
    expect((await calendarMirrorRepository.profile(fixture.personalWorkspaceId))!.state).toBe("removing");
    await calendarMirrorRepository.releaseStaleRemoving(new Date(Date.now() + 11 * 60_000), 10);
    expect((await calendarMirrorRepository.profile(fixture.personalWorkspaceId))!.state).toBe("active");
  });
});
