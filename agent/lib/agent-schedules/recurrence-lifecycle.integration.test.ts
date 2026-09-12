/** Integration coverage of interval and calendar recurrence through real CRUD and completion. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { reminderDispatchRepository } from "../reminders/reminder-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}

async function fixture(timezone: string) {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Recurrence') RETURNING id");
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('recurrence-owner', 'Владелец') RETURNING id",
  );
  const familyId = family.rows[0]!.id;
  const userId = user.rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
  const auth = {
    familyId, userId, role: "owner" as const, forumTopicId: null, groupId: null, groupType: null,
    messageThreadId: null, telegramChatId: "recurrence-owner", telegramChatType: "private" as const,
    telegramUserId: "recurrence-owner",
  };
  await reminderRepository.configureNotifications(auth, { quietEnd: null, quietStart: null, timezone });
  return auth;
}

const cases = [
  { unit: "minutely", interval: 1, anchor: "2026-01-01T12:00:00Z", after: "2026-09-12T12:07:30Z", next: "2026-09-12T12:08:00.000Z", timezone: "UTC" },
  { unit: "minutely", interval: 5, anchor: "2026-09-12T12:00:00Z", after: "2026-09-12T12:07:30Z", next: "2026-09-12T12:10:00.000Z", timezone: "UTC" },
  { unit: "hourly", interval: 2, anchor: "2026-09-12T12:00:00Z", after: "2026-09-12T14:00:00Z", next: "2026-09-12T16:00:00.000Z", timezone: "UTC" },
  // The first 02:30 in the autumn overlap must retain its exact UTC identity.
  { unit: "hourly", interval: 1, anchor: "2026-10-25T02:30:00+02:00", after: "2026-10-25T00:31:00Z", next: "2026-10-25T01:30:00.000Z", timezone: "Europe/Berlin" },
  { unit: "hourly", interval: 1, anchor: "2026-03-29T01:30:00+01:00", after: "2026-03-29T00:31:00Z", next: "2026-03-29T01:30:00.000Z", timezone: "Europe/Berlin" },
  { unit: "monthly", interval: 1, anchor: "2026-01-31T09:00:00Z", after: "2026-01-31T09:01:00Z", next: "2026-02-28T09:00:00.000Z", timezone: "UTC" },
  { unit: "monthly", interval: 2, anchor: "2026-07-31T09:00:00Z", after: "2026-08-01T09:01:00Z", next: "2026-09-30T09:00:00.000Z", timezone: "UTC" },
  { unit: "yearly", interval: 1, anchor: "2024-02-29T09:00:00Z", after: "2024-02-29T09:01:00Z", next: "2025-02-28T09:00:00.000Z", timezone: "UTC" },
  { unit: "yearly", interval: 2, anchor: "2024-02-29T09:00:00Z", after: "2024-02-29T09:01:00Z", next: "2026-02-28T09:00:00.000Z", timezone: "UTC" },
  { unit: "yearly", interval: 1, anchor: "2024-02-29T09:00:00Z", after: "2027-03-01T09:00:00Z", next: "2028-02-29T09:00:00.000Z", timezone: "UTC" },
  { unit: "daily", interval: 1, anchor: "2026-03-28T08:00:00Z", after: "2026-03-28T08:01:00Z", next: "2026-03-29T07:00:00.000Z", timezone: "Europe/Berlin" },
] as const;

for (const target of ["reminder", "agent"] as const) {
  (enabled ? describe : describe.skip)(`${target} recurrence lifecycle`, () => {
    beforeEach(async () => {
      await database().query("TRUNCATE families, users CASCADE");
    });
    afterAll(closeDatabase);

    async function setup(unit: string, interval: number, anchor: string, timezone: string) {
      const auth = await fixture(timezone);
      const firstRunAt = new Date(anchor);
      const record = target === "reminder"
        ? await reminderRepository.create(auth, {
          content: "Напоминание", firstRunAt, operationKey: "create", recurrence: { unit, interval } as never, scope: "personal", timezone,
        })
        : await agentScheduleRepository.create(auth, {
          title: "Сценарий", scenarioPrompt: "Проверь ресурс", userRequest: "Проверяй по расписанию", firstRunAt,
          operationKey: "create", recurrence: { kind: unit, interval } as never, scope: "personal", timezone,
        });
      return { auth, id: record.id };
    }

    async function complete(auth: Awaited<ReturnType<typeof fixture>>, now: string, after: string) {
      const options = { now: new Date(now), limit: 1, leaseMilliseconds: 600_000 };
      if (target === "reminder") {
        const [job] = await reminderDispatchRepository.claimDue(options);
        expect(job).toBeDefined();
        await reminderDispatchRepository.markDispatchStarted(job!.id, job!.leaseToken);
        await reminderDispatchRepository.complete(job!, new Date(after), { messageId: `${Date.parse(now)}`, text: "Напоминание" });
        return (await reminderRepository.list(auth, { limit: 10 })).items[0]!;
      }
      const [job] = await agentScheduleDispatchRepository.claimDue(options);
      expect(job).toBeDefined();
      const session = await sessionRepository.prepareTurn({
        baseContinuationToken: `recurrence::${job!.runId}`, kind: "scheduled", telegramForumTopicId: null,
        familyId: auth.familyId, groupId: null, now: options.now, scope: "personal", userId: auth.userId,
      });
      await agentScheduleDispatchRepository.markDispatchStarted(job!, { applicationSessionId: session.id });
      await agentScheduleDispatchRepository.markRunning(job!, { applicationSessionId: session.id, eveSessionId: job!.runId });
      // A later minute tick must not launch another copy of the same running scenario.
      expect(await agentScheduleDispatchRepository.claimDue({ ...options, now: new Date(after) })).toEqual([]);
      await agentScheduleDispatchRepository.completeDeliveredRun({
        applicationSessionId: session.id, eveSessionId: job!.runId, runId: job!.runId,
        content: "Готово", deliveredAt: new Date(after), familyId: auth.familyId, groupId: null,
        messageThreadId: null, ownerUserId: auth.userId, scheduledFor: new Date(job!.nextRunAt),
        scope: "personal", telegramChatId: auth.telegramChatId, telegramMessageId: `${Date.parse(now)}`, title: job!.title,
      });
      return (await agentScheduleRepository.list(auth, { limit: 10 })).items[0]!;
    }

    it.each(cases)("$unit x$interval from $anchor after $after", async ({ unit, interval, anchor, after, next, timezone }) => {
      const { auth, id } = await setup(unit, interval, anchor, timezone);
      const record = await complete(auth, anchor, after);
      expect(record).toMatchObject({ id, status: "active", nextRunAt: next });
      expect(record.recurrence).toEqual(target === "reminder" ? { unit, interval } : { kind: unit, interval });
    });

    it.each([
      { unit: "monthly", anchor: "2026-01-31T09:00:00Z", second: "2026-02-28T09:00:00Z", next: "2026-03-31T09:00:00.000Z" },
      { unit: "yearly", anchor: "2024-02-29T09:00:00Z", second: "2025-02-28T09:00:00Z", next: "2028-02-29T09:00:00.000Z" },
    ])("retains original $unit day across completions and a pause", async ({ unit, anchor, second, next }) => {
      const { auth, id } = await setup(unit, 1, anchor, "UTC");
      await complete(auth, anchor, anchor);
      const repository = target === "reminder" ? reminderRepository : agentScheduleRepository;
      await repository.update(auth, id, { enabled: false, operationKey: "pause" });
      await repository.update(auth, id, { enabled: true, operationKey: "resume" });
      const after = unit === "yearly" ? "2027-03-01T09:00:00Z" : second;
      expect(await complete(auth, second, after)).toMatchObject({ nextRunAt: next });
    });

    it("updates an existing daily schedule to an hourly interval with the exact ambiguous first instant", async () => {
      const { auth, id } = await setup("daily", 1, "2026-01-01T09:00:00Z", "Europe/Berlin");
      const date = new Date("2026-10-25T02:30:00+02:00");
      const recurrence = target === "reminder" ? { unit: "hourly", interval: 1 } : { kind: "hourly", interval: 1 };
      const changes = { operationKey: "update", recurrence, ...(target === "reminder" ? { firstRunAt: date } : { nextRunAt: date }) };
      const repository = target === "reminder" ? reminderRepository : agentScheduleRepository;
      const updated = await repository.update(auth, id, changes as never);
      const replay = await repository.update(auth, id, changes as never);
      expect(replay).toEqual(updated);
      expect(updated).toMatchObject({ id, recurrence });
      expect(await complete(auth, date.toISOString(), "2026-10-25T00:31:00Z"))
        .toMatchObject({ nextRunAt: "2026-10-25T01:30:00.000Z" });
    });

    it.each(["minutely", "hourly"] as const)("preserves the exact %s anchor through text changes and pause/resume", async (unit) => {
      const interval = unit === "minutely" ? 60 : 1;
      const anchor = "2026-10-25T02:30:00+02:00";
      const { auth, id } = await setup(unit, interval, anchor, "Europe/Berlin");
      const table = target === "reminder" ? "reminders" : "agent_schedules";
      const readAnchors = () => database().query(
        `SELECT recurrence_anchor_at, recurrence_anchor_local::text, occurrence_index FROM ${table} WHERE id = $1`, [id],
      );
      const before = await readAnchors();
      if (target === "reminder") {
        await reminderRepository.update(auth, id, { content: "Другой текст", operationKey: "text-change" });
      } else {
        await agentScheduleRepository.update(auth, id, { title: "Другое название", operationKey: "text-change" });
      }
      const repository = target === "reminder" ? reminderRepository : agentScheduleRepository;
      await repository.update(auth, id, { enabled: false, operationKey: "pause" });
      await repository.update(auth, id, { enabled: true, operationKey: "resume" });
      expect((await readAnchors()).rows).toEqual(before.rows);
      expect(await complete(auth, anchor, "2026-10-25T00:31:00Z"))
        .toMatchObject({ nextRunAt: "2026-10-25T01:30:00.000Z" });
    });

    if (target === "reminder") {
      it("skips missed biweekly reminders across the spring clock change", async () => {
        const { auth, id } = await setup("weekly", 2, "2026-03-15T08:00:00Z", "Europe/Berlin");
        expect(await complete(auth, "2026-03-15T08:00:00Z", "2026-03-29T07:01:00Z"))
          .toMatchObject({ nextRunAt: "2026-04-12T07:00:00.000Z" });
        const row = await database().query("SELECT occurrence_index FROM reminders WHERE id = $1", [id]);
        expect(row.rows[0].occurrence_index).toBe(2);
      });
    }
  });
}
