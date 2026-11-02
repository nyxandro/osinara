/**
 * PostgreSQL tests of the mirror calendar inside the Google connection's actions.
 *
 * Constructs covered:
 * - A family member who may not disconnect the family's Google cannot remove its calendar either:
 *   the refusal comes before anything changes.
 * - Without a calendar there is nothing to remove, and the disconnect's end returns the profile to work.
 * - Only the family owner brings back a deleted family calendar; it then comes back on the next cycle.
 * - The status tells the model how far the calendar is.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { GoogleIntegrationAuthorization } from "../google-workspace/google-integration-contract.js";
import {
  calendarMirrorStatus,
  finishDisconnect,
  removeCalendarBeforeDisconnect,
  restoreRemindersCalendar,
} from "./calendar-mirror-connection.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function familyWithGoogle(): Promise<{ member: GoogleIntegrationAuthorization; owner: GoogleIntegrationAuthorization }> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Связь') RETURNING id");
  const familyId = family.rows[0]!.id;
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('connection-owner', 'Владелец'), ('connection-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "connection-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "connection-member")!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    [familyId, ownerId, memberId],
  );
  const workspace = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, scope) VALUES ($1, 'family') RETURNING id",
    [familyId],
  );
  const workspaceId = workspace.rows[0]!.id;
  const account = await database().query<{ id: string }>(
    `INSERT INTO integration_accounts
       (family_id, connected_by_user_id, workspace_id, provider, external_account_id, display_name,
        status, scopes, is_default)
     VALUES ($1, $2, $3, 'google_workspace', 'family-google', 'family@example.com', 'active', ARRAY['scope'], true)
     RETURNING id`,
    [familyId, ownerId, workspaceId],
  );
  await calendarMirrorRepository.applyConnection(database(), {
    externalAccountId: "family-google",
    integrationAccountId: account.rows[0]!.id,
    workspaceId,
  });
  const base = { familyId, scope: "family" as const, workspaceId };
  return {
    member: { ...base, role: "member", telegramUserId: "connection-member", userId: memberId },
    owner: { ...base, role: "owner", telegramUserId: "connection-owner", userId: ownerId },
  };
}

describeWithDatabase("calendar mirror connection", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE calendar_mirror_copies, calendar_mirror_profiles, reminders, telegram_groups, integration_accounts,
                workspaces, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("refuses a member before the family calendar is touched", async () => {
    const { member } = await familyWithGoogle();
    await calendarMirrorRepository.setCalendar(member.workspaceId, "family-calendar@group.calendar.google.com");

    await expect(removeCalendarBeforeDisconnect(member)).rejects.toMatchObject({ code: "AGENT_OWNER_REQUIRED" });
    expect(await calendarMirrorRepository.profile(member.workspaceId)).toMatchObject({
      calendarId: "family-calendar@group.calendar.google.com",
      state: "active",
    });
  });

  it("has nothing to remove without a calendar and returns the profile to work after the disconnect", async () => {
    const { owner } = await familyWithGoogle();
    await expect(removeCalendarBeforeDisconnect(owner)).resolves.toBe("nothing_to_remove");
    await calendarMirrorRepository.markRemoving(owner.workspaceId);
    await finishDisconnect(owner.workspaceId);
    expect((await calendarMirrorRepository.profile(owner.workspaceId))!.state).toBe("active");
  });

  it("counts every copy removed by the bot before Google is asked, so a failed removal deletes no reminder later", async () => {
    const { owner } = await familyWithGoogle();
    await calendarMirrorRepository.setCalendar(owner.workspaceId, "family-calendar@group.calendar.google.com");
    const family = await database().query<{ id: string }>("SELECT id FROM families LIMIT 1");
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-connection', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
      [family.rows[0]!.id],
    );
    const reminder = await database().query<{ id: string }>(
      `INSERT INTO reminders (family_id, author_user_id, group_id, scope, content, timezone, telegram_chat_id,
                              recurrence_anchor_local, due_at, available_at)
       VALUES ($1, $2, $3, 'family', 'Дача', 'Europe/Moscow', '-100-connection', '2099-03-01 10:00',
               '2099-03-01T07:00:00Z', '2099-03-01T07:00:00Z') RETURNING id`,
      [family.rows[0]!.id, owner.userId, group.rows[0]!.id],
    );
    const copy = await calendarMirrorRepository.insertPendingCopy(owner.workspaceId, reminder.rows[0]!.id, "osrfamily");
    await calendarMirrorRepository.recordCopyWritten(copy.id, {
      etag: "\"e\"", eventUpdated: null, fingerprint: "a".repeat(64), pushed: null, seriesStartLocal: null, shown: true,
    });
    const previous = process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    try {
      await expect(removeCalendarBeforeDisconnect(owner)).resolves.toBe("failed");
    } finally {
      if (previous !== undefined) process.env.GOOGLE_OAUTH_CLIENT_ID = previous;
    }
    expect(await calendarMirrorRepository.copies(owner.workspaceId)).toEqual([
      expect.objectContaining({ id: copy.id, shown: false }),
    ]);
    expect(await calendarMirrorRepository.profile(owner.workspaceId)).toMatchObject({
      calendarId: "family-calendar@group.calendar.google.com",
      state: "removing",
    });
  });

  it("lets only the family owner bring back a deleted calendar", async () => {
    const { member, owner } = await familyWithGoogle();
    await calendarMirrorRepository.setCalendar(owner.workspaceId, "deleted@group.calendar.google.com");
    await calendarMirrorRepository.stop(owner.workspaceId, "stopped_calendar_deleted", "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED");

    await expect(restoreRemindersCalendar(member)).rejects.toMatchObject({ code: "AGENT_OWNER_REQUIRED" });
    expect((await calendarMirrorRepository.profile(owner.workspaceId))!.state).toBe("stopped_calendar_deleted");

    await expect(restoreRemindersCalendar(owner)).resolves.toMatchObject({
      calendar: "Осинара — семейные напоминания",
      state: "catching_up",
    });
    expect(await calendarMirrorRepository.profile(owner.workspaceId)).toMatchObject({
      calendarId: null,
      state: "active",
      stopNoticeAt: null,
    });
  });

  it("reports a stopped calendar and a missing connection", async () => {
    const { owner } = await familyWithGoogle();
    await calendarMirrorRepository.stop(owner.workspaceId, "stopped_access_lost", "AGENT_CALENDAR_MIRROR_ACCESS_LOST");
    expect(await calendarMirrorStatus(owner.workspaceId)).toMatchObject({
      lastErrorCode: "AGENT_CALENDAR_MIRROR_ACCESS_LOST",
      state: "stopped_access_lost",
    });
    await database().query("DELETE FROM integration_accounts WHERE workspace_id = $1", [owner.workspaceId]);
    expect(await calendarMirrorStatus(owner.workspaceId)).toMatchObject({ state: "not_connected" });
  });
});
