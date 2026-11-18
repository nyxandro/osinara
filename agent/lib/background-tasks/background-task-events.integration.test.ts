/**
 * Bringing background tasks' questions and outcomes to their chats (#519).
 *
 * Constructs covered:
 * - An outcome is answered only after the main agent's turn ended well; a failed turn brings it back in
 *   five minutes, and an answered outcome makes the task reported. A turn already created is let finish.
 * - An unreachable model hub spends no attempt and is tried ever less often, for a day after the event was
 *   ready (17.11.2026 the hub was down an hour, as long as twelve attempts last); then the event is given up.
 * - A chat with no conversation right now keeps the event waiting without spending an attempt, up to a day.
 * - An author who lost access is not told anything; a question answered meanwhile is not asked.
 * - A retelling that may have reached the chat (delivered, unknown outcome, a part arrived) is not told again.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { bindContinuation } from "../../runtime/session/continuations.js";
import { telegramContinuationToken } from "../../runtime/telegram/api.js";
import { loadTurn } from "../../runtime/turn/journal-repository.js";
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import { newTestSession } from "../../runtime/turn/turn.integration-fixtures.js";
import { BACKGROUND_TASK_ANSWER_WAIT_MS, BACKGROUND_TASK_CONCURRENCY, BACKGROUND_TASK_EVENT_ATTEMPTS } from "./background-task-config.js";
import { createBackgroundTaskEventProcessor } from "./background-task-events.js";
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

let fixture: BackgroundTaskFixture;
let now = new Date();

function processor(runTurn: (turnId: string) => Promise<TurnOutcome>) {
  return createBackgroundTaskEventProcessor({
    database: database(), now: () => now, runTurn, slots: { release: () => undefined, tryAcquire: () => true },
  });
}

async function finishedTask(): Promise<string> {
  const task = await createTestTask(fixture);
  await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, now);
  await backgroundTaskRepository.finish({ code: "AGENT_BACKGROUND_TASK_FINISHED", id: task.id, now, state: "finished", text: "Готово" });
  return task.id;
}

/** The next attempt is due now and finds the turn it made already there (the test has no live conversation). */
async function retryTurnMade(taskId: string): Promise<void> {
  await database().query(
    "UPDATE background_task_events SET available_at = $2, turn_id = 'turn-' || gen_random_uuid() WHERE task_id = $1", [taskId, now],
  );
}

/** The record of a retelling turn's answer in the chat, as Telegram delivery keeps it. */
async function finalDelivery(turnId: string, status: "ambiguous" | "delivered" | "failed", chunks: number): Promise<void> {
  const ended = status !== "delivered";
  const row = await database().query<{ id: string }>(
    `INSERT INTO telegram_final_deliveries (agent_session_id, agent_turn_id, output_hash, expected_chunk_count, status,
       diagnostic_code, started_at, completed_at)
     VALUES ('wrun_test', $1, repeat('a', 64), 2, $2, $3, now(), now()) RETURNING id`,
    [turnId, status, ended ? `AGENT_TELEGRAM_FINAL_DELIVERY_${status.toUpperCase()}` : null],
  );
  for (let ordinal = 0; ordinal < chunks; ordinal += 1) {
    await database().query(
      `INSERT INTO telegram_final_delivery_chunks (delivery_id, ordinal, content_hash, telegram_message_id, telegram_chat_type)
       VALUES ($1, $2, repeat('b', 64), $3, 'private')`,
      [row.rows[0]!.id, ordinal, 5000 + ordinal],
    );
  }
}

/** How long the event waits from `now` before its next attempt. */
async function pauseOf(taskId: string): Promise<number> {
  const result = await database().query<{ available_at: Date }>("SELECT available_at FROM background_task_events WHERE task_id = $1", [taskId]);
  return result.rows[0]!.available_at.getTime() - now.getTime();
}

async function eventOf(taskId: string) {
  const result = await database().query<{ attempt_count: number; last_error_code: string | null; status: string }>(
    "SELECT status, attempt_count, last_error_code FROM background_task_events WHERE task_id = $1", [taskId],
  );
  return result.rows[0];
}

describeWithDatabase("background task events", () => {
  beforeEach(async () => {
    now = new Date();
    await truncateBackgroundTaskTables();
    fixture = await createBackgroundTaskFixture();
  });
  afterAll(closeDatabase);

  it("retries an outcome whose turn failed, and answers it once a turn ended well", async () => {
    const taskId = await finishedTask();
    // The turn an earlier attempt created: the processor lets it finish instead of creating another.
    await database().query("UPDATE background_task_events SET turn_id = 'turn-made-before' WHERE task_id = $1", [taskId]);
    const failed = vi.fn(async () => ({ code: "AGENT_MODEL_UNAVAILABLE", message: "down", status: "failed" }) as TurnOutcome);
    expect(await processor(failed)()).toBe(true);
    expect(failed).toHaveBeenCalledWith("turn-made-before");
    expect(await eventOf(taskId)).toEqual({ attempt_count: 1, last_error_code: "AGENT_MODEL_UNAVAILABLE", status: "pending" });
    // Not due again before the pause.
    expect(await processor(failed)()).toBe(false);

    now = new Date(now.getTime() + 5 * 60_000 + 1_000);
    await database().query("UPDATE background_task_events SET turn_id = 'turn-made-again' WHERE task_id = $1", [taskId]);
    const completed = vi.fn(async () => ({ status: "completed", text: "Пересказал" }) as TurnOutcome);
    expect(await processor(completed)()).toBe(true);
    expect((await eventOf(taskId))?.status).toBe("answered");
    expect((await backgroundTaskRepository.find(taskId))?.state).toBe("reported");
  });

  it("waits out an unreachable model hub without spending attempts, ever less often, and gives up after a day", async () => {
    const taskId = await finishedTask();
    const createdAt = now;
    // The last attempt is at hand: a failure that spent it would give the outcome up.
    await database().query(
      "UPDATE background_task_events SET turn_id = 'turn-during-outage', attempt_count = $2 WHERE task_id = $1",
      [taskId, BACKGROUND_TASK_EVENT_ATTEMPTS - 1],
    );
    const outage = vi.fn(async () => ({ code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", message: "down", status: "failed" }) as TurnOutcome);
    expect(await processor(outage)()).toBe(true);
    expect(await eventOf(taskId)).toEqual({
      attempt_count: BACKGROUND_TASK_EVENT_ATTEMPTS - 1, last_error_code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", status: "pending",
    });
    expect(await pauseOf(taskId)).toBe(5 * 60_000);

    // Half an hour into the outage the next try waits as long again; the pause never grows past an hour.
    now = new Date(createdAt.getTime() + 30 * 60_000);
    await retryTurnMade(taskId);
    expect(await processor(outage)()).toBe(true);
    expect(await pauseOf(taskId)).toBe(30 * 60_000);
    now = new Date(createdAt.getTime() + 5 * 60 * 60_000);
    await retryTurnMade(taskId);
    expect(await processor(outage)()).toBe(true);
    expect(await pauseOf(taskId)).toBe(60 * 60_000);

    // A day after the outcome was ready nobody waits for it any more.
    now = new Date(createdAt.getTime() + BACKGROUND_TASK_ANSWER_WAIT_MS + 1_000);
    await retryTurnMade(taskId);
    expect(await processor(outage)()).toBe(true);
    expect(await eventOf(taskId)).toEqual({
      attempt_count: BACKGROUND_TASK_EVENT_ATTEMPTS - 1, last_error_code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", status: "gave_up",
    });
  });

  it("spends an attempt on a model failure that is not the hub being out of reach", async () => {
    const taskId = await finishedTask();
    await retryTurnMade(taskId);
    const empty = vi.fn(async () => ({ code: "AGENT_MODEL_OUTPUT_INCOMPLETE", message: "empty", status: "failed" }) as TurnOutcome);
    expect(await processor(empty)()).toBe(true);
    expect(empty).toHaveBeenCalled();
    expect(await eventOf(taskId)).toMatchObject({ attempt_count: 1, status: "pending" });
  });

  it("does not tell an outcome again once its retelling may have reached the chat", async () => {
    // 17.11.2026 Telegram answered 504 to a retelling the person received, and a retry told it twice.
    const cases = [
      { chunks: 0, expected: "answered", status: "ambiguous" },
      { chunks: 0, expected: "answered", status: "delivered" },
      // One part arrived before Telegram refused the next: a new retelling would repeat that part.
      { chunks: 1, expected: "answered", status: "failed" },
      // Refused before anything arrived: nothing to repeat, the outcome is told again.
      { chunks: 0, expected: "pending", status: "failed" },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const taskId = await finishedTask();
      const turnId = `turn-retelling-${index}`;
      await database().query("UPDATE background_task_events SET turn_id = $2, available_at = $3 WHERE task_id = $1", [taskId, turnId, now]);
      await finalDelivery(turnId, item.status, item.chunks);
      const failed = vi.fn(async () => ({
        code: "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED", message: "Telegram", status: "failed",
      }) as TurnOutcome);
      expect(await processor(failed)(), item.status).toBe(true);
      expect((await eventOf(taskId))?.status, `${item.status}/${item.chunks}`).toBe(item.expected);
      if (item.expected === "answered") expect((await backgroundTaskRepository.find(taskId))?.state).toBe("reported");
    }
  });

  it("brings an outcome into the chat's current conversation as the task's report, then answers it", async () => {
    const taskId = await finishedTask();
    // The chat's live conversation: its runtime session, bound to the Telegram channel and the chat's route.
    const agentSessionId = await newTestSession();
    const conversation = await database().query<{ id: string }>("SELECT id FROM conversation_sessions WHERE agent_session_id = $1", [agentSessionId]);
    await database().query(
      "INSERT INTO conversation_session_routes (base_continuation_token, session_id) VALUES ($1, $2)",
      [telegramContinuationToken({ chatId: fixture.telegramChatId }), conversation.rows[0]!.id],
    );
    await bindContinuation(database(), { channelKind: "telegram", sessionId: agentSessionId, token: `${fixture.telegramChatId}::` });
    const seen: { auth?: Record<string, unknown>; kind?: string; message?: unknown } = {};
    const runTurn = vi.fn(async (turnId: string) => {
      const turn = await loadTurn(database(), turnId);
      Object.assign(seen, { auth: turn.auth.current?.attributes, kind: turn.kind, message: turn.input.message });
      return { status: "completed", text: "Пересказал" } as TurnOutcome;
    });
    expect(await processor(runTurn)()).toBe(true);
    expect(seen.kind).toBe("wakeup");
    expect(seen.auth).toMatchObject({ applicationSessionId: conversation.rows[0]!.id, backgroundTaskEventId: expect.any(String), telegramChatId: fixture.telegramChatId });
    expect(seen.auth).not.toHaveProperty("backgroundTaskId");
    expect(String(seen.message)).toContain("<background_task_outcome>");
    expect(String(seen.message)).toContain("Готово");
    expect((await eventOf(taskId))?.status).toBe("answered");
    expect((await backgroundTaskRepository.find(taskId))?.state).toBe("reported");
  });

  it("waits for the chat's conversation without spending an attempt, and gives up after a day", async () => {
    const taskId = await finishedTask();
    const runTurn = vi.fn();
    expect(await processor(runTurn)()).toBe(true);
    expect(await eventOf(taskId)).toEqual({ attempt_count: 0, last_error_code: "AGENT_BACKGROUND_TASK_CONVERSATION_IDLE", status: "pending" });
    now = new Date(now.getTime() + 24 * 60 * 60_000 + 60_000);
    expect(await processor(runTurn)()).toBe(true);
    expect(await eventOf(taskId)).toMatchObject({ last_error_code: "AGENT_BACKGROUND_TASK_CONVERSATION_GONE", status: "gave_up" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("tells nothing to an author who lost access", async () => {
    const taskId = await finishedTask();
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [fixture.userId]);
    expect(await processor(vi.fn())()).toBe(true);
    expect(await eventOf(taskId)).toMatchObject({ last_error_code: "AGENT_BACKGROUND_TASK_ACCESS_LOST", status: "gave_up" });
  });

  it("does not ask a question the person already answered", async () => {
    const task = await createTestTask(fixture);
    await backgroundTaskRepository.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, now);
    await backgroundTaskRepository.recordQuestion(task.id, "Какой год?");
    await backgroundTaskRepository.waitForAnswer(task.id, now);
    await backgroundTaskMessageRepository.append({
      authorUserId: fixture.userId, createdByCallId: "m1", createdByTurnId: "main", now, taskId: task.id, text: "2025",
    });
    const runTurn = vi.fn();
    expect(await processor(runTurn)()).toBe(true);
    expect(runTurn).not.toHaveBeenCalled();
    expect((await eventOf(task.id))?.status).toBe("answered");
  });
});
