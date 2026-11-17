/**
 * Bringing background tasks' questions and outcomes to their chats (#519).
 *
 * Constructs covered:
 * - An outcome is answered only after the main agent's turn ended well; a failed turn brings it back in
 *   five minutes, and an answered outcome makes the task reported. A turn already created is let finish.
 * - A chat with no conversation right now keeps the event waiting without spending an attempt, up to a day.
 * - An author who lost access is not told anything; a question answered meanwhile is not asked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { bindContinuation } from "../../runtime/session/continuations.js";
import { telegramContinuationToken } from "../../runtime/telegram/api.js";
import { loadTurn } from "../../runtime/turn/journal-repository.js";
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import { newTestSession } from "../../runtime/turn/turn.integration-fixtures.js";
import { BACKGROUND_TASK_CONCURRENCY } from "./background-task-config.js";
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
