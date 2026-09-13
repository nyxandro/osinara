/** Real PostgreSQL coverage of bounded delivery and pause while a run owns the schedule. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../app-error.js";
import { deliverTelegramFinalOutput } from "../telegram-final-delivery.js";
import { telegramFinalDeliveryRepository } from "../telegram-final-delivery-repository.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { agentScheduleRepository as schedules } from "./agent-schedule-repository.js";
import { agentScheduleDispatchRepository as dispatch } from "./agent-schedule-dispatch-repository.js";
import { admitScheduledAgentTurn } from "./agent-schedule-recovery.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Нужна отдельная БД *_test");
}

(enabled ? describe : describe.skip)("limited schedule lifecycle", () => {
  beforeEach(async () => { await database().query("TRUNCATE families, users CASCADE"); });
  afterAll(closeDatabase);

  async function setup(maxRuns: number | null = 2) {
    const familyId = (await database().query("INSERT INTO families(name) VALUES ('Limits') RETURNING id")).rows[0].id;
    const userId = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES ('123','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId,userId]);
    const auth = { familyId, userId, role: "owner" as const, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, telegramChatId: "123", telegramChatType: "private" as const, telegramUserId: "123" };
    const schedule = await schedules.create(auth, { firstRunAt: new Date("2026-09-14T12:00:00Z"),
      operationKey: "create", recurrence: { kind: "minutely", interval: 1 }, maxRuns,
      scenarioPrompt: "Пришли погоду", scope: "personal", timezone: "UTC", title: "Погода", userRequest: "Два раза" });
    return { auth, schedule };
  }

  async function start(auth: Awaited<ReturnType<typeof setup>>["auth"], now: string) {
    const [job] = await dispatch.claimDue({ now: new Date(now), limit: 1, leaseMilliseconds: 60_000 });
    expect(job).toBeDefined();
    const session = await sessionRepository.prepareTurn({ baseContinuationToken: `limits:${job!.runId}`,
      kind: "scheduled", telegramForumTopicId: null, familyId: auth.familyId, groupId: null,
      now: new Date(now), scope: "personal", userId: auth.userId });
    await dispatch.markDispatchStarted(job!, { applicationSessionId: session.id });
    await admitScheduledAgentTurn({ runId: job!.runId, applicationSessionId: session.id, eveSessionId: job!.runId, eveTurnId: "turn_0" });
    const receipt = { applicationSessionId: session.id, eveSessionId: job!.runId, runId: job!.runId,
      content: "Погода", deliveredAt: new Date(Date.parse(now) + 10_000), familyId: auth.familyId, groupId: null,
      messageThreadId: null, ownerUserId: auth.userId, scheduledFor: new Date(job!.nextRunAt), scope: "personal" as const,
      telegramChatId: "123", telegramMessageId: String(Date.parse(now)), title: "Погода" };
    return { job: job!, receipt };
  }

  it("completes exactly at the delivery limit, survives reconnect and ignores duplicate receipts", async () => {
    const { auth, schedule } = await setup();
    const first = await start(auth, "2026-09-14T12:00:00Z");
    expect(first.job).toMatchObject({ completedRuns: 0, maxRuns: 2 });
    await dispatch.completeDeliveredRun(first.receipt);
    expect(await dispatch.completeDeliveredRun(first.receipt)).toBe(false);
    await closeDatabase();
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 1, maxRuns: 2, status: "active" });
    const second = await start(auth, "2026-09-14T12:01:00Z");
    expect(second.job).toMatchObject({ completedRuns: 1, maxRuns: 2 });
    await dispatch.completeDeliveredRun(second.receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ completedRuns: 2, status: "completed" });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T13:00:00Z"), limit: 10, leaseMilliseconds: 60_000 })).toEqual([]);
    await expect(schedules.update(auth, schedule.id, { enabled: true, operationKey: "resume" })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_LIMIT_REACHED" });
    await expect(schedules.runNow(auth, schedule.id, "now")).rejects.toMatchObject({ code: "AGENT_SCHEDULE_LIMIT_REACHED" });
  });

  it.each([false, true])("accepts pause during execution and preserves it after completion (failure=%s)", async (failure) => {
    const { auth, schedule } = await setup();
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    const input = { enabled: false, operationKey: "pause" };
    expect(await schedules.update(auth, schedule.id, input)).toMatchObject({ status: "leased", pauseRequested: true });
    expect(await schedules.update(auth, schedule.id, input)).toMatchObject({ pauseRequested: true });
    await dispatch.authorizeDelivery(receipt);
    if (failure) await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId, "AGENT_TEST_FAILURE", receipt.deliveredAt);
    else await dispatch.completeDeliveredRun(receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "paused", pauseRequested: false, completedRuns: failure ? 0 : 1 });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T13:00:00Z"), limit: 10, leaseMilliseconds: 60_000 })).toEqual([]);
  });

  it("does not consume the delivery limit on a failed run", async () => {
    const { auth, schedule } = await setup(1);
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId, "AGENT_TEST_FAILURE", receipt.deliveredAt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "active", completedRuns: 0 });
    const next = await start(auth, "2026-09-14T12:01:00Z");
    await dispatch.completeDeliveredRun(next.receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "completed", completedRuns: 1 });
  });

  it("keeps ordinary mutations blocked during a run", async () => {
    const { auth, schedule } = await setup();
    await start(auth, "2026-09-14T12:00:00Z");
    await expect(schedules.update(auth, schedule.id, { enabled: false, title: "Other", operationKey: "mixed" }))
      .rejects.toMatchObject({ code: "AGENT_SCHEDULE_RUN_IN_PROGRESS" });
  });

  it("does not let another family member pause a running personal schedule", async () => {
    const { auth, schedule } = await setup();
    await start(auth, "2026-09-14T12:00:00Z");
    const otherId = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES ('456','Member') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES ($1,$2,'member')", [auth.familyId, otherId]);
    await expect(schedules.update({ ...auth, userId: otherId }, schedule.id, { enabled: false, operationKey: "other-pause" }))
      .rejects.toMatchObject({ code: "AGENT_SCHEDULE_MUTATION_DENIED" });
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "leased", pauseRequested: false });
  });

  it.each(["AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS", "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING"])(
    "stops instead of scheduling another attempt after %s", async (code) => {
      const { auth, schedule } = await setup();
      const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
      await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId, code, receipt.deliveredAt);
      expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "failed", completedRuns: 0, lastErrorCode: code });
      expect(await dispatch.claimDue({ now: new Date("2026-09-14T13:00:00Z"), limit: 1, leaseMilliseconds: 60_000 })).toEqual([]);
    });

  it("serializes a delivery racing with pause without reopening the schedule", async () => {
    const { auth, schedule } = await setup();
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    await Promise.all([
      dispatch.completeDeliveredRun(receipt),
      dispatch.completeDeliveredRun(receipt),
      schedules.update(auth, schedule.id, { enabled: false, operationKey: "pause" }),
    ]);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "paused", completedRuns: 1 });
  });

  it.each([false, true])("preserves requested pause through an expired pre-model lease (handoff=%s)", async (handoff) => {
    const { auth, schedule } = await setup();
    const now = new Date("2026-09-14T12:00:00Z");
    const [job] = await dispatch.claimDue({ now, limit: 1, leaseMilliseconds: 60_000 });
    if (handoff) {
      const session = await sessionRepository.prepareTurn({ baseContinuationToken: `limits:${job!.runId}`,
        kind: "scheduled", telegramForumTopicId: null, familyId: auth.familyId, groupId: null, now,
        scope: "personal", userId: auth.userId });
      await dispatch.markDispatchStarted(job!, { applicationSessionId: session.id });
    }
    await schedules.update(auth, schedule.id, { enabled: false, operationKey: "pause" });
    await closeDatabase();
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T12:02:00Z"), limit: 1, leaseMilliseconds: 60_000 })).toEqual([]);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "paused", pauseRequested: false, completedRuns: 0 });
  });

  it("keeps the count on limit changes and requires explicit resume after extending a finished schedule", async () => {
    const { auth, schedule } = await setup(1);
    await dispatch.completeDeliveredRun((await start(auth, "2026-09-14T12:00:00Z")).receipt);
    expect(await schedules.update(auth, schedule.id, { maxRuns: 2, operationKey: "extend" }))
      .toMatchObject({ status: "completed", completedRuns: 1, maxRuns: 2 });
    await schedules.update(auth, schedule.id, { enabled: true, nextRunAt: new Date("2026-09-14T12:01:00Z"), operationKey: "resume" });
    await dispatch.completeDeliveredRun((await start(auth, "2026-09-14T12:01:00Z")).receipt);
    await expect(schedules.update(auth, schedule.id, { maxRuns: 1, operationKey: "lower" }))
      .rejects.toMatchObject({ code: "AGENT_SCHEDULE_LIMIT_INVALID" });
    expect(await schedules.update(auth, schedule.id, { maxRuns: null, operationKey: "unlimited" }))
      .toMatchObject({ completedRuns: 2, maxRuns: null });
  });

  it("completes at the limit even when pause was requested on the final run", async () => {
    const { auth, schedule } = await setup(1);
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    await schedules.update(auth, schedule.id, { enabled: false, operationKey: "pause" });
    await dispatch.completeDeliveredRun(receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "completed", pauseRequested: false, completedRuns: 1 });
  });

  it("resumes an extended completed schedule at a new occurrence without replaying the delivered one", async () => {
    const { auth, schedule } = await setup(1);
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    await dispatch.completeDeliveredRun(receipt);
    await schedules.update(auth, schedule.id, { maxRuns: 2, operationKey: "extend" });
    const resumed = await schedules.update(auth, schedule.id, { enabled: true, operationKey: "resume" });
    expect(resumed.nextRunAt).not.toBe(schedule.nextRunAt);
    const next = await start(auth, resumed.nextRunAt);
    await dispatch.completeDeliveredRun(next.receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "completed", completedRuns: 2 });
  });

  it("stops after Telegram accepts a message but receipt storage throws a different error code", async () => {
    const { auth, schedule } = await setup();
    const { receipt } = await start(auth, "2026-09-14T12:00:00Z");
    const outage = new AppError("AGENT_DATABASE_UNAVAILABLE", "Не удалось сохранить подтверждение");
    const confirm = vi.spyOn(telegramFinalDeliveryRepository, "confirmChunk").mockRejectedValueOnce(outage);
    const sendChunk = vi.fn().mockResolvedValue({ chatType: "private", messageId: "1234" });
    try {
      await expect(deliverTelegramFinalOutput({ applicationSessionId: receipt.applicationSessionId,
        deliveryIdentity: { chatId: "123" }, eveSessionId: receipt.eveSessionId, eveTurnId: "turn_0",
        markdown: "Погода", sendChunk })).rejects.toBe(outage);
    } finally {
      confirm.mockRestore();
    }
    expect(sendChunk).toHaveBeenCalledOnce();
    // The Telegram channel passes the original storage error to the schedule boundary.
    await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId, outage.code, receipt.deliveredAt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "failed", completedRuns: 0 });
    expect(await dispatch.claimDue({ now: new Date("2026-09-14T13:00:00Z"), limit: 1, leaseMilliseconds: 60_000 })).toEqual([]);
  });

  it("resumes after run_now even when PostgreSQL stored sub-millisecond time", async () => {
    const { auth, schedule } = await setup(1);
    await schedules.runNow(auth, schedule.id, "now");
    // Deterministically reproduce PostgreSQL now() precision, without relying on the clock's last digits.
    await database().query("UPDATE agent_schedules SET next_run_at=date_trunc('milliseconds',next_run_at)+interval '123 microseconds' WHERE id=$1", [schedule.id]);
    const now = new Date(Date.now() + 1000).toISOString();
    const { receipt } = await start(auth, now);
    await dispatch.completeDeliveredRun(receipt);
    await schedules.update(auth, schedule.id, { maxRuns: 2, operationKey: "extend" });
    const resumed = await schedules.update(auth, schedule.id, { enabled: true, operationKey: "resume" });
    const next = await start(auth, resumed.nextRunAt);
    await dispatch.completeDeliveredRun(next.receipt);
    expect(await schedules.findById(auth, schedule.id)).toMatchObject({ status: "completed", completedRuns: 2 });
  });

  // Exhaustive property over all three-event success/failure streams, with duplicate delivery replay.
  it.each(Array.from({ length: 8 }, (_, mask) => mask))("counts only unique confirmed deliveries for event stream %i", async (mask) => {
    const { auth, schedule } = await setup(2);
    let deliveries = 0;
    for (let index = 0; index < 3; index++) {
      const now = new Date(Date.parse("2026-09-14T12:00:00Z") + index * 60_000);
      if (deliveries === 2) {
        expect(await dispatch.claimDue({ now, limit: 1, leaseMilliseconds: 60_000 })).toEqual([]);
        break;
      }
      const { receipt } = await start(auth, now.toISOString());
      if ((mask & (1 << index)) !== 0) {
        await dispatch.completeDeliveredRun(receipt);
        await dispatch.completeDeliveredRun(receipt);
        deliveries++;
      } else {
        await dispatch.failRun(receipt.applicationSessionId, receipt.eveSessionId, "AGENT_TEST_FAILURE", receipt.deliveredAt);
      }
      expect(await schedules.findById(auth, schedule.id)).toMatchObject({
        completedRuns: deliveries, status: deliveries === 2 ? "completed" : "active",
      });
    }
  });
});
