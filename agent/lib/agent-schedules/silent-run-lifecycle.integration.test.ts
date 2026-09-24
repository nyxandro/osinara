/**
 * Real PostgreSQL coverage of a scheduled run that deliberately sends nothing.
 *
 * A scenario may say "skip the report when there is nothing worth sending". Such a run is a
 * successful run without a message: the schedule keeps its recurrence and the owner receives no
 * failure notice. It still counts as an execution, because maxRuns limits executions and a limited
 * scenario that keeps finding nothing must end rather than call the model forever. Silence after a
 * delivery may already have started is not silence and keeps the unconfirmed-delivery stop.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { deliverTelegramFinalOutput } from "../telegram-final-delivery.js";
import { telegramFinalDeliveryRepository } from "../telegram-final-delivery-repository.js";
import { agentScheduleDispatchRepository as dispatch } from "./agent-schedule-dispatch-repository.js";
import { admitScheduledAgentTurn } from "./agent-schedule-recovery.js";
import { agentScheduleRepository as schedules } from "./agent-schedule-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Нужна отдельная БД *_test");
}

(enabled ? describe : describe.skip)("silent scheduled run", () => {
  beforeEach(async () => { await database().query("TRUNCATE families, users CASCADE"); });
  afterAll(closeDatabase);

  async function setup(maxRuns: number | null = null) {
    const familyId = (await database().query("INSERT INTO families(name) VALUES ('Silence') RETURNING id")).rows[0].id;
    const userId = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES ('123','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId, userId]);
    const auth = { familyId, userId, role: "owner" as const, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, telegramChatId: "123", telegramChatType: "private" as const, telegramUserId: "123" };
    const schedule = await schedules.create(auth, { firstRunAt: new Date("2026-09-14T12:00:00Z"),
      operationKey: "create", recurrence: { kind: "minutely", interval: 1 }, maxRuns,
      scenarioPrompt: "Проверь чейнжлог и напиши, только если там что-то стоящее", scope: "personal",
      timezone: "UTC", title: "Чейнжлог", userRequest: "Скипай несущественное" });
    return { auth, schedule };
  }

  async function start(auth: Awaited<ReturnType<typeof setup>>["auth"], now: string) {
    const [job] = await dispatch.claimDue({ now: new Date(now), limit: 1, leaseMilliseconds: 60_000 });
    expect(job).toBeDefined();
    const session = await sessionRepository.prepareTurn({ baseContinuationToken: `silence:${job!.runId}`,
      kind: "scheduled", telegramForumTopicId: null, familyId: auth.familyId, groupId: null,
      now: new Date(now), scope: "personal", userId: auth.userId });
    await dispatch.markDispatchStarted(job!, { applicationSessionId: session.id });
    await admitScheduledAgentTurn({ runId: job!.runId, applicationSessionId: session.id, eveSessionId: job!.runId, eveTurnId: "turn_0" });
    const receipt = { applicationSessionId: session.id, eveSessionId: job!.runId, runId: job!.runId,
      content: "Чейнжлог", deliveredAt: new Date(Date.parse(now) + 10_000), familyId: auth.familyId, groupId: null,
      messageThreadId: null, ownerUserId: auth.userId, scheduledFor: new Date(job!.nextRunAt), scope: "personal" as const,
      telegramChatId: "123", telegramMessageId: String(Date.parse(now)), title: "Чейнжлог" };
    return { job: job!, receipt };
  }

  async function runRow(runId: string) {
    return (await database().query<{ error_code: string | null; status: string }>(
      "SELECT status::text, error_code FROM agent_schedule_runs WHERE id = $1", [runId],
    )).rows[0];
  }

  async function incidents(runId: string) {
    return Number((await database().query<{ count: string }>(
      "SELECT count(*) FROM operational_incidents WHERE operation_key = $1", [`schedule-run:${runId}`],
    )).rows[0]!.count);
  }

  it("keeps a recurring schedule running after a run that had nothing to send", async () => {
    const { auth, schedule } = await setup();
    const { job, receipt } = await start(auth, "2026-09-14T12:00:00Z");

    expect(await dispatch.completeSilentRun(receipt.applicationSessionId, receipt.eveSessionId, receipt.deliveredAt))
      .toBe(true);
    // The channel still closes the turn afterwards; it must find nothing left to fail.
    expect(await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId,
      "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", receipt.deliveredAt)).toBe(false);

    expect(await runRow(job.runId)).toEqual({ error_code: null, status: "completed" });
    expect(await incidents(job.runId)).toBe(0);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 1, status: "active" });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T12:01:00Z"), limit: 1, leaseMilliseconds: 60_000 }))
      .toHaveLength(1);
  });

  it("ends a limited scenario that keeps finding nothing instead of running forever", async () => {
    // "Check every minute, ten times, write only if the site is down": with the site up every run
    // is silent, and not counting them would call the model every minute with no end.
    const { auth, schedule } = await setup(2);
    for (const now of ["2026-09-14T12:00:00Z", "2026-09-14T12:01:00Z"]) {
      const { receipt } = await start(auth, now);
      await dispatch.completeSilentRun(receipt.applicationSessionId, receipt.eveSessionId, receipt.deliveredAt);
    }

    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 2, status: "completed" });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T12:05:00Z"), limit: 1, leaseMilliseconds: 60_000 }))
      .toEqual([]);
  });

  it("closes a one-time schedule whose only run had nothing to send", async () => {
    const { auth, schedule } = await setup();
    await schedules.update(auth, schedule.id, { recurrence: { kind: "once" }, operationKey: "once" });
    const { job, receipt } = await start(auth, "2026-09-14T12:00:00Z");

    await dispatch.completeSilentRun(receipt.applicationSessionId, receipt.eveSessionId, receipt.deliveredAt);

    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 1, status: "completed" });
    expect(await incidents(job.runId)).toBe(0);
  });

  it("keeps the unconfirmed-delivery stop when a message may already have been sent", async () => {
    const { auth, schedule } = await setup();
    const { job, receipt } = await start(auth, "2026-09-14T12:00:00Z");
    const outage = new AppError("AGENT_DATABASE_UNAVAILABLE", "Не удалось сохранить подтверждение");
    const confirm = vi.spyOn(telegramFinalDeliveryRepository, "confirmChunk").mockRejectedValueOnce(outage);
    try {
      await expect(deliverTelegramFinalOutput({ applicationSessionId: receipt.applicationSessionId,
        deliveryIdentity: { chatId: "123" }, eveSessionId: receipt.eveSessionId, eveTurnId: "turn_0",
        markdown: "Чейнжлог", sendChunk: vi.fn().mockResolvedValue({ chatType: "private", messageId: "1234" }) }))
        .rejects.toBe(outage);
    } finally {
      confirm.mockRestore();
    }

    expect(await dispatch.completeSilentRun(receipt.applicationSessionId, receipt.eveSessionId, receipt.deliveredAt))
      .toBe(true);

    expect(await runRow(job.runId)).toEqual({
      error_code: "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
      status: "failed",
    });
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 0, status: "failed" });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T12:01:00Z"), limit: 1, leaseMilliseconds: 60_000 }))
      .toEqual([]);
  });
});
