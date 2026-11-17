/**
 * Background task storage integration tests (#519).
 *
 * Constructs covered:
 * - A repeat of the same tool call returns the task it created; the same call id in another turn is another task;
 *   an unknown state is refused by the table.
 * - At most three tasks run; a fourth waits in the queue and starts when a place frees.
 * - Waiting for an answer does not count as work; an answer puts the task back in the queue.
 * - A correction is shown to one tool call once; a parallel call of the same step does not see it; a turn that
 *   ended without delivering it frees it for the next turn.
 * - Every end writes one outcome event; an event failed twelve times is given up; an answered outcome makes
 *   the task reported.
 * - A stop ends a queued task at once and marks a running one.
 * - The erasure takes only ended tasks older than thirty days.
 * - A deploy never waits for a running task, but waits for an event being answered.
 * - The runtime's recovery leaves a task's running turn to the task dispatcher.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { listRunningRootTurns } from "../../runtime/turn/journal-repository.js";
import { newTestSession } from "../../runtime/turn/turn.integration-fixtures.js";
import { startTurn } from "../../runtime/turn/turn-start.js";
import { BACKGROUND_TASK_CONCURRENCY, BACKGROUND_TASK_EVENT_ATTEMPTS, BACKGROUND_TASK_EVENT_LEASE_MS } from "./background-task-config.js";
import { backgroundTaskEventRepository } from "./background-task-event-repository.js";
import { backgroundTaskMessageRepository } from "./background-task-message-repository.js";
import { backgroundTaskRepository } from "./background-task-repository.js";
import {
  createBackgroundTaskFixture,
  createTestTask,
  truncateBackgroundTaskTables,
  type BackgroundTaskFixture,
} from "./background-task.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const T0 = new Date("2026-11-16T10:00:00.000Z");
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

async function message(taskId: string, text: string, turnId: string, callId = "msg-call") {
  return await backgroundTaskMessageRepository.append({
    authorUserId: fixture.userId, createdByCallId: callId, createdByTurnId: turnId, now: T0, taskId, text,
  });
}

/** The SQL of `runtime_is_idle` in the deploy script, run against this database. */
async function deployIdleVerdict(): Promise<string> {
  const script = readFileSync("scripts/production-deploy/backup.sh", "utf8");
  const body = script.slice(script.indexOf("runtime_is_idle()"));
  const sql = body.slice(body.indexOf("<<'SQL'") + "<<'SQL'".length, body.indexOf("\nSQL\n")).trim();
  const result = await database().query<{ case: string }>(sql);
  return result.rows[0]!.case;
}

let fixture: BackgroundTaskFixture;

describeWithDatabase("background task repository", () => {
  beforeEach(async () => {
    await truncateBackgroundTaskTables();
    fixture = await createBackgroundTaskFixture();
  });
  afterAll(closeDatabase);

  it("returns the same task for a repeated call and a new one for the same call id in another turn", async () => {
    const first = await createTestTask(fixture, { callId: "call-1", turnId: "turn-1" });
    const repeated = await createTestTask(fixture, { callId: "call-1", turnId: "turn-1" });
    const other = await createTestTask(fixture, { callId: "call-1", turnId: "turn-2" });
    expect(repeated.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    await expect(database().query("UPDATE background_tasks SET state = 'paused' WHERE id = $1", [first.id])).rejects.toThrow();
  });

  it("runs three tasks and queues the fourth until a place frees", async () => {
    const tasks = [];
    for (let index = 0; index < 4; index += 1) tasks.push(await createTestTask(fixture));
    const started = [];
    for (let index = 0; index < 4; index += 1) started.push(await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0));
    expect(started.filter((task) => task !== null)).toHaveLength(3);
    expect((await backgroundTaskRepository.find(tasks[3]!.id))?.state).toBe("queued");
    await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FINISHED", id: tasks[0]!.id, now: minutes(1), state: "finished", text: "Готово" });
    expect((await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, minutes(1)))?.id).toBe(tasks[3]!.id);
  });

  it("stops the clock while a question waits, and an answer puts the task back in the queue", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.recordStep(task.id, minutes(2));
    expect(await backgroundTaskRepository.recordQuestion(task.id, "Считать допсоглашения отдельно?")).toBe(true);
    const waiting = await backgroundTaskRepository.waitForAnswer(task.id, minutes(5));
    expect(waiting).toMatchObject({ activeMs: 5 * 60_000, questionSeq: 1, state: "waiting_answer" });
    await backgroundTaskRepository.expireUnanswered(minutes(60), 24 * 60 * 60_000);
    expect((await backgroundTaskRepository.find(task.id))?.activeMs).toBe(5 * 60_000);
    expect(await message(task.id, "Отдельно", "turn-answer")).toBe("resumes");
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ state: "queued", waitingQuestion: null });
    const events = await database().query("SELECT kind, question_seq FROM background_task_events WHERE task_id = $1", [task.id]);
    expect(events.rows).toEqual([{ kind: "question", question_seq: 1 }]);
  });

  it("does not ask when a message came after the question, and does not end a task a correction waits for", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.recordQuestion(task.id, "Какой год?");
    expect(await message(task.id, "2025", "turn-answer")).toBe("next_step");
    expect(await backgroundTaskRepository.waitForAnswer(task.id, T0)).toBe("messages_pending");
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ state: "running", waitingQuestion: null });
    expect(await backgroundTaskRepository.finishUnlessMessages({
      code: "AGENT_BACKGROUND_TASK_FINISHED", id: task.id, now: T0, state: "finished", text: "Готово",
    })).toBe("messages_pending");
    const events = await database().query("SELECT 1 FROM background_task_events WHERE task_id = $1", [task.id]);
    expect(events.rowCount).toBe(0);
  });

  it("ends a question nobody answered within a day", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.recordQuestion(task.id, "Какой год?");
    await backgroundTaskRepository.waitForAnswer(task.id, T0);
    expect(await backgroundTaskRepository.expireUnanswered(minutes(24 * 60), 24 * 60 * 60_000)).toBe(1);
    expect((await backgroundTaskRepository.find(task.id))?.state).toBe("unanswered");
  });

  it("shows a correction to one call once, frees it from a turn that ended, and keeps it from a parallel call", async () => {
    const task = await createTestTask(fixture);
    await message(task.id, "Только 2025 год", "turn-main");
    const shown = await backgroundTaskMessageRepository.claimForCall(task.id, { callId: "c1", turnId: "t1" });
    expect(shown.map((item) => item.text)).toEqual(["Только 2025 год"]);
    expect(await backgroundTaskMessageRepository.claimForCall(task.id, { callId: "c2", turnId: "t1" })).toEqual([]);
    expect(await backgroundTaskMessageRepository.claimForCall(task.id, { callId: "c1", turnId: "t1" })).toHaveLength(1);
    // The turn ended before its next step: the next turn may see the message again.
    expect(await backgroundTaskMessageRepository.claimForCall(task.id, { callId: "c1", turnId: "t2" })).toHaveLength(1);
    expect(await backgroundTaskMessageRepository.markDelivered(task.id, "t2", T0)).toBe(1);
    expect(await backgroundTaskMessageRepository.claimForCall(task.id, { callId: "c9", turnId: "t3" })).toEqual([]);
    expect(await backgroundTaskMessageRepository.hasUndelivered(task.id)).toBe(false);
  });

  it("stops a queued task at once and marks a running one", async () => {
    const running = await createTestTask(fixture);
    const queued = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(1, T0);
    expect(await backgroundTaskRepository.requestStop(queued.id, T0)).toBe("stopped");
    expect(await backgroundTaskRepository.requestStop(running.id, T0)).toBe("stopping");
    expect(await backgroundTaskRepository.requestStop(queued.id, T0)).toBeNull();
    expect(await message(queued.id, "ещё", "turn-x")).toBeNull();
    expect(await message(running.id, "ещё", "turn-y")).toBeNull();
  });

  it("writes one outcome event per end, gives it up after twelve failures, and reports an answered outcome", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FINISHED", id: task.id, now: T0, state: "finished", text: "Готово" });
    expect(await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FAILED", id: task.id, now: T0, state: "failed", text: null })).toBeNull();
    let now = T0;
    for (let attempt = 1; attempt <= BACKGROUND_TASK_EVENT_ATTEMPTS; attempt += 1) {
      const event = await backgroundTaskEventRepository.claim(now, BACKGROUND_TASK_EVENT_LEASE_MS);
      expect(event?.kind).toBe("outcome");
      const result = await backgroundTaskEventRepository.retry(event!, "AGENT_MODEL_UNAVAILABLE", now);
      expect(result).toBe(attempt === BACKGROUND_TASK_EVENT_ATTEMPTS ? "gave_up" : "retry");
      now = new Date(now.getTime() + 5 * 60_000);
    }
    expect(await backgroundTaskEventRepository.claim(new Date(now.getTime() + 60 * 60_000), BACKGROUND_TASK_EVENT_LEASE_MS)).toBeNull();

    const second = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FINISHED", id: second.id, now: T0, state: "finished", text: "Итог" });
    const event = await backgroundTaskEventRepository.claim(T0, BACKGROUND_TASK_EVENT_LEASE_MS);
    expect(await backgroundTaskEventRepository.answer(event!, minutes(1))).toBe(true);
    expect(await backgroundTaskRepository.find(second.id)).toMatchObject({ reportedAt: minutes(1), state: "reported" });
  });

  it("erases only ended tasks older than thirty days", async () => {
    const old = await createTestTask(fixture);
    const active = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_STOPPED", id: old.id, now: T0, state: "stopped", text: null });
    await database().query("UPDATE background_tasks SET created_at = $1", [new Date(T0.getTime() - 31 * 24 * 60 * 60_000)]);
    expect(await backgroundTaskRepository.purgeOld(T0, 100)).toBe(1);
    expect(await backgroundTaskRepository.find(old.id)).toBeNull();
    expect(await backgroundTaskRepository.find(active.id)).not.toBeNull();
  });

  it("does not hold a deploy for a running task, but holds it for an event being answered", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, T0);
    await database().query(
      `INSERT INTO conversation_sessions (thread_id, generation, family_id, owner_user_id, scope, kind, task_state,
         conversation_key, continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', 'background', 'running', 'bg', 'bg', now(), now())`,
      [fixture.familyId, fixture.userId],
    );
    expect(await deployIdleVerdict()).toBe("idle");
    await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FINISHED", id: task.id, now: T0, state: "finished", text: "Готово" });
    await backgroundTaskEventRepository.claim(T0, BACKGROUND_TASK_EVENT_LEASE_MS);
    expect(await deployIdleVerdict()).toBe("busy");
  });

  it("leaves a task's running turn out of the runtime's recovery", async () => {
    const sessionId = await newTestSession();
    const auth = { attributes: { backgroundTaskId: "1" }, authenticator: "telegram", principalId: fixture.userId, principalType: "user" };
    const turn = await startTurn(database(), {
      auth: { current: auth, initiator: auth }, channel: { kind: "background-task" }, input: { context: [], message: "задача" },
      kind: "background", parent: null, sessionId,
    });
    expect((await listRunningRootTurns(database())).map((running) => running.id)).not.toContain(turn.id);
  });
});
