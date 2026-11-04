/**
 * Reminders when the person's timezone is unknown or was guessed (#451), against PostgreSQL.
 *
 * Constructs covered:
 * - A clock time without a zone waits with its follow-up schedule; a countdown is set at once in UTC;
 *   an offset the model would have guessed is refused; replays answer with the same wait.
 * - Saving the zone sets the waits in the same transaction, reports the missed and the recently
 *   expired ones, and sends a family wait to its group.
 * - A correction of a zone the agent guessed moves only the person's own reminders created since,
 *   pauses one moved into the past, and leaves family and Google-made reminders alone.
 * - The agent never replaces a zone that exists; quiet hours stay through a zone change.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createReminderOrWait } from "./reminder-create.js";
import { reminderRepository } from "./reminder-repository.js";
import { timezoneWaitRepository } from "./reminder-timezone-wait-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture { familyId: string; groupId: string; memberId: string; ownerId: string }

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Пояса') RETURNING id");
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('tz-owner', 'Владелец'), ('tz-member', 'Участница') RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "tz-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "tz-member")!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-tz', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

function privateAuth(fixture: Fixture) {
  return {
    familyId: fixture.familyId, forumTopicId: null, groupId: null, groupType: null, messageThreadId: null,
    role: "member" as const, telegramChatId: "tz-member", telegramChatType: "private" as const, userId: fixture.memberId,
  };
}

function familyAuth(fixture: Fixture) {
  return {
    ...privateAuth(fixture), forumTopicId: null, groupId: fixture.groupId, groupType: "family_private" as const,
    messageThreadId: null, telegramChatId: "-100-tz", telegramChatType: "supergroup" as const,
  };
}

const request = (operationKey: string, time: Parameters<typeof createReminderOrWait>[1]["time"], extra: object = {}) => ({
  content: "Полить цветы", operationKey, recurrence: null, scope: "personal" as const, time, ...extra,
});

async function waitRow(id: string) {
  const result = await database().query<{
    expires_at: Date; next_followup_at: Date | null; reminder_id: string | null; second_followup_at: Date | null; status: string;
  }>("SELECT status, reminder_id, next_followup_at, second_followup_at, expires_at FROM reminder_timezone_waits WHERE id = $1", [id]);
  return result.rows[0]!;
}

async function reminderRow(id: string) {
  const result = await database().query<{ due_at: Date; scope: string; status: string; telegram_chat_id: string; timezone: string }>(
    "SELECT due_at, scope, status, telegram_chat_id, timezone FROM reminders WHERE id = $1", [id],
  );
  return result.rows[0]!;
}

describeWithDatabase("reminders and the person's timezone", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE reminder_timezone_waits, reminder_operations, reminders, audit_events, user_notification_settings,
                telegram_groups, family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it("keeps a clock time without a zone waiting and schedules the questions", async () => {
    const fixture = await createFixture();
    const outcome = await createReminderOrWait(
      privateAuth(fixture),
      request("wait-1", { kind: "local", local: "2026-11-05T12:20:00" }),
      new Date("2026-11-03T07:53:00Z"),
    );
    expect(outcome).toMatchObject({
      awaiting: { localFirstRun: "2026-11-05T12:20", status: "awaiting_timezone", suggestedLabel: "Москва" },
      kind: "awaiting",
    });
    const row = await waitRow(outcome.kind === "awaiting" ? outcome.awaiting.id : "");
    expect(row.next_followup_at?.toISOString()).toBe("2026-11-03T10:53:00.000Z");
    expect(row.second_followup_at?.toISOString()).toBe("2026-11-05T06:00:00.000Z");
    expect(row.expires_at.toISOString()).toBe("2026-11-06T00:20:00.000Z");
  });

  it("sets a clock time at once in a zone that is known", async () => {
    const fixture = await createFixture();
    await reminderRepository.configureNotifications(privateAuth(fixture), { basis: null, source: "person", timezone: "Europe/Moscow" });
    const outcome = await createReminderOrWait(privateAuth(fixture), request("known-1", { kind: "local", local: "2026-12-05T12:20:00" }));
    expect(outcome).toMatchObject({ kind: "reminder", reminder: { nextRunAt: "2026-12-05T09:20:00.000Z", timezone: "Europe/Moscow" } });
  });

  it("sets a countdown without a zone and refuses what would need one", async () => {
    const fixture = await createFixture();
    const now = new Date("2026-11-03T07:00:00Z");
    const outcome = await createReminderOrWait(privateAuth(fixture), request("count-1", { kind: "countdown", minutes: 20 }), now);
    expect(outcome).toMatchObject({ kind: "reminder", reminder: { nextRunAt: "2026-11-03T07:20:00.000Z", timezone: "UTC" } });
    await expect(createReminderOrWait(
      privateAuth(fixture),
      request("count-2", { kind: "countdown", minutes: 20 }, { recurrence: { interval: 1, unit: "daily" } }),
      now,
    )).rejects.toThrowError(/AGENT_REMINDER_LOCAL_TIME_REQUIRED/);
    await expect(createReminderOrWait(
      privateAuth(fixture),
      request("count-3", { at: new Date("2026-11-04T09:00:00Z"), kind: "absolute", timezone: "Europe/Moscow" }),
      now,
    )).rejects.toThrowError(/AGENT_REMINDER_LOCAL_TIME_REQUIRED/);
  });

  it("answers a replay with the same wait and refuses other input under its key", async () => {
    const fixture = await createFixture();
    const first = await createReminderOrWait(privateAuth(fixture), request("replay-1", { kind: "local", local: "2026-12-01T09:00:00" }));
    const again = await createReminderOrWait(privateAuth(fixture), request("replay-1", { kind: "local", local: "2026-12-01T09:00:00" }));
    expect(again).toEqual(first);
    await expect(createReminderOrWait(privateAuth(fixture), request("replay-1", { kind: "local", local: "2026-12-01T10:00:00" })))
      .rejects.toThrowError(/AGENT_REMINDER_OPERATION_CONFLICT/);
  });

  it("lists, changes and cancels a wait", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture);
    const created = await createReminderOrWait(auth, request("list-1", { kind: "local", local: "2026-12-01T09:00:00" }));
    const id = created.kind === "awaiting" ? created.awaiting.id : "";
    expect(await timezoneWaitRepository.list(auth)).toHaveLength(1);
    const changed = await timezoneWaitRepository.update(auth, id, { content: "Полить фикус", localFirstRun: "2026-12-02T18:30:00", now: new Date("2026-11-03T07:00:00Z") });
    expect(changed).toMatchObject({ content: "Полить фикус", localFirstRun: "2026-12-02T18:30" });
    expect((await waitRow(id)).second_followup_at?.toISOString()).toBe("2026-12-02T06:00:00.000Z");
    await expect(timezoneWaitRepository.delete(auth, id, new Date())).resolves.toBe(true);
    await expect(timezoneWaitRepository.delete(auth, id, new Date())).resolves.toBe(true);
    expect(await timezoneWaitRepository.list(auth)).toHaveLength(0);
    const set = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Europe/Moscow" });
    expect(set.activated).toHaveLength(0);
  });

  it("sets the waits when the zone is saved and tells what was missed", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture);
    const requested = new Date("2026-11-02T07:00:00Z");
    const ahead = await createReminderOrWait(auth, request("act-1", { kind: "local", local: "2026-11-05T12:20:00" }), requested);
    const passed = await createReminderOrWait(auth, request("act-2", { kind: "local", local: "2026-11-03T08:00:00" }), requested);
    const daily = await createReminderOrWait(
      auth,
      request("act-3", { kind: "local", local: "2026-11-03T09:00:00" }, { recurrence: { interval: 1, unit: "daily" } }),
      requested,
    );
    const ended = await createReminderOrWait(auth, request("act-4", { kind: "local", local: "2026-11-01T09:00:00" }), requested);
    const id = (outcome: typeof ahead) => outcome.kind === "awaiting" ? outcome.awaiting.id : "";
    await database().query(
      "UPDATE reminder_timezone_waits SET status = 'expired', resolved_at = '2026-11-02T00:00:00Z' WHERE id = $1",
      [id(ended)],
    );

    const now = new Date("2026-11-03T07:00:00Z"); // 10:00 in Moscow
    const set = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Europe/Moscow" }, now);

    expect(set.localTimeNow).toBe("2026-11-03T10:00");
    expect(set.activated.map((item) => item.nextRunAt).sort()).toEqual(["2026-11-04T06:00:00.000Z", "2026-11-05T09:20:00.000Z"]);
    expect(set.missed).toEqual([{ content: "Полить цветы", localFirstRun: "2026-11-03T08:00", reason: "time_passed" }]);
    expect(set.expiredRecently).toEqual([{ content: "Полить цветы", localFirstRun: "2026-11-01T09:00" }]);
    expect(await waitRow(id(ahead))).toMatchObject({ next_followup_at: null, status: "activated" });
    expect(await waitRow(id(passed))).toMatchObject({ reminder_id: null, status: "missed" });
    const dailyReminder = (await waitRow(id(daily))).reminder_id!;
    expect(await reminderRow(dailyReminder)).toMatchObject({ status: "active", timezone: "Europe/Moscow" });
  });

  it("sends a family wait to its group once the author's zone is known", async () => {
    const fixture = await createFixture();
    const outcome = await createReminderOrWait(
      familyAuth(fixture),
      request("family-1", { kind: "local", local: "2026-12-06T10:00:00" }, { scope: "family" }),
      new Date("2026-11-03T07:00:00Z"),
    );
    const row = await waitRow(outcome.kind === "awaiting" ? outcome.awaiting.id : "");
    expect(row.next_followup_at?.toISOString()).toBe("2026-11-03T07:01:00.000Z");
    const set = await reminderRepository.configureNotifications(privateAuth(fixture), { basis: null, source: "person", timezone: "Europe/Moscow" });
    expect(await reminderRow(set.activated[0]!.id)).toMatchObject({ scope: "family", telegram_chat_id: "-100-tz" });
  });

  it("moves the person's own reminders when they correct a guessed zone, and nothing else", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture);
    await reminderRepository.configureNotifications(auth, { basis: "город Тула из разговора", source: "agent", timezone: "Europe/Moscow" });
    const own = await createReminderOrWait(auth, request("shift-1", { kind: "local", local: "2026-12-10T12:20:00" }));
    const family = await createReminderOrWait(
      familyAuth(fixture),
      request("shift-2", { kind: "local", local: "2026-12-10T12:20:00" }, { scope: "family" }),
    );
    const google = await createReminderOrWait(auth, request("shift-3", { kind: "local", local: "2026-12-11T15:00:00" }));
    const reminderId = (outcome: typeof own) => outcome.kind === "reminder" ? outcome.reminder.id : "";
    await database().query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'reminder.created', $3, '{"source":"google_calendar"}'::jsonb)`,
      [fixture.familyId, fixture.memberId, reminderId(google)],
    );
    await expect(reminderRepository.configureNotifications(auth, { basis: "геолокация", source: "agent", timezone: "Asia/Yerevan" }))
      .rejects.toThrowError(/AGENT_NOTIFICATION_TIMEZONE_ALREADY_SET/);

    const corrected = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Asia/Yerevan" });

    expect(corrected.shifted).toEqual([{ content: "Полить цветы", id: reminderId(own), nextRunAt: "2026-12-10T08:20:00.000Z" }]);
    expect(await reminderRow(reminderId(own))).toMatchObject({ timezone: "Asia/Yerevan" });
    expect((await reminderRow(reminderId(family))).due_at.toISOString()).toBe("2026-12-10T09:20:00.000Z");
    expect(await reminderRow(reminderId(google))).toMatchObject({ timezone: "Europe/Moscow" });
    const again = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Europe/Moscow" });
    expect(again.shifted).toEqual([]);
  });

  it("pauses a one-time reminder that the correction puts in the past", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture);
    await reminderRepository.configureNotifications(auth, { basis: "город Тула из разговора", source: "agent", timezone: "Europe/Moscow" }, new Date("2026-11-03T06:00:00Z"));
    const created = await createReminderOrWait(auth, request("past-1", { kind: "local", local: "2026-11-03T12:20:00" }), new Date("2026-11-03T06:30:00Z"));
    const id = created.kind === "reminder" ? created.reminder.id : "";
    // 11:30 in Moscow; 12:20 in Yerevan was 11:20 in Moscow.
    const corrected = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Asia/Yerevan" }, new Date("2026-11-03T08:30:00Z"));
    expect(corrected.shiftedIntoPast).toEqual([{ content: "Полить цветы", id, pausedAt: "2026-11-03T08:20:00.000Z" }]);
    expect(await reminderRow(id)).toMatchObject({ status: "paused" });
  });

  it("keeps quiet hours through a zone change and sets each wait once under concurrent saves", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture);
    await createReminderOrWait(auth, request("race-1", { kind: "local", local: "2026-12-20T09:00:00" }));
    const saves = await Promise.all([1, 2].map(() =>
      reminderRepository.configureNotifications(auth, { basis: null, quietEnd: "08:00", quietStart: "23:00", source: "person", timezone: "Europe/Moscow" })));
    expect(saves.flatMap((save) => save.activated)).toHaveLength(1);
    const moved = await reminderRepository.configureNotifications(auth, { basis: null, source: "person", timezone: "Asia/Yerevan" });
    expect(moved).toMatchObject({ quietEnd: "08:00", quietStart: "23:00" });
  });
});
