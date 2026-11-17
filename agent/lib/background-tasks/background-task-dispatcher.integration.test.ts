/**
 * Background task dispatcher integration tests (#519): the real turn loop over the test database with a
 * scripted model.
 *
 * Constructs covered:
 * - A task runs in its own session and ends with its final text and the files it names; its session retires.
 * - `ask_person` frees the place and waits; the answer starts a new turn that has it in its input.
 * - A stop cuts the step under way and the summary turn writes what was done; a failed summary falls back
 *   to the journal.
 * - The hour cuts a step that hangs; the hundredth step stops the task before the model is paid again.
 * - A lost right stops the task before any model call.
 * - A turn left by a previous process is continued, never started twice.
 * - While a deploy prepares, nothing starts.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../database.js";
import { defineTool } from "../../runtime/tool.js";
import { TurnCancelledError } from "../../runtime/turn/model-errors.js";
import type { StepModelCall } from "../../runtime/turn/model-call.js";
import { reply, scriptedModel, testAgent, testRuntime, toolCalls, type ScriptStep } from "../../runtime/turn/turn.integration-fixtures.js";
import { loadBackgroundTaskAccess } from "./background-task-access.js";
import { BACKGROUND_TASK_ACTIVE_LIMIT_MS, BACKGROUND_TASK_STEP_LIMIT } from "./background-task-config.js";
import { createBackgroundTaskDispatcher } from "./background-task-dispatcher.js";
import { backgroundTaskMessageRepository } from "./background-task-message-repository.js";
import { backgroundTaskRepository } from "./background-task-repository.js";
import { backgroundTaskToolSurface } from "./background-task-tools.js";
import { createBackgroundTaskTurn } from "./background-task-turn.js";
import { backgroundTaskObserver, recordBackgroundTaskStep } from "./background-task-turn-events.js";
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
let phase = "ready";

// A tool that does nothing: a step that calls it is one more model step of the task.
const NOOP = defineTool({ description: "noop", inputSchema: z.object({}).strict(), execute: async () => "ok" });

function harness(...steps: ScriptStep[]) {
  return harnessWith({ maxModelSteps: 32 }, ...steps);
}

function harnessWith(options: { readonly maxModelSteps: number }, ...steps: ScriptStep[]) {
  const model = scriptedModel(...steps);
  const runtime = testRuntime({
    agent: testAgent({}, {
      maxModelSteps: options.maxModelSteps,
      resolveTools: async (ctx) => backgroundTaskToolSurface(ctx, { noop: NOOP }),
      stepStarted: (ctx) => recordBackgroundTaskStep(ctx),
    }),
    callModel: model.callModel,
    observer: backgroundTaskObserver(),
  });
  const dispatcher = createBackgroundTaskDispatcher({
    holdsRunnerLock: async () => true, now: () => new Date(), pollMilliseconds: 50, readPhase: async () => phase, runtime,
  });
  return { dispatcher, model, runtime };
}

/** A model step that never answers until its turn is cut; `started` resolves when it was called. */
function hangingStep() {
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const step = (call: StepModelCall) => {
    started();
    return new Promise<never>((_resolve, reject) => {
      call.abortSignal?.addEventListener("abort", () => reject(new TurnCancelledError()), { once: true });
    });
  };
  return { called, step };
}

async function run(dispatcher: ReturnType<typeof harness>["dispatcher"]): Promise<void> {
  await dispatcher.pass();
  await dispatcher.idle();
}

function requestText(call: { readonly messages: unknown }): string {
  return JSON.stringify(call.messages);
}

describeWithDatabase("background task dispatcher", () => {
  beforeEach(async () => {
    phase = "ready";
    await truncateBackgroundTaskTables();
    fixture = await createBackgroundTaskFixture();
  });
  afterAll(closeDatabase);

  it("ends a task with its final text and the files it names, and retires its session", async () => {
    const task = await createTestTask(fixture);
    const file = `/workspace/personal/background/${task.id}/сроки.csv`;
    const { dispatcher, model } = harness(reply(`Готово: 31 договор, таблица ${file}.`));
    await run(dispatcher);
    const ended = await backgroundTaskRepository.find(task.id);
    expect(ended).toMatchObject({ outcomeCode: "AGENT_BACKGROUND_TASK_FINISHED", outcomeFiles: [file], state: "finished", steps: 1 });
    expect(requestText(model.requests[0]!)).toContain("Сведи сроки из всех договоров");
    const session = await database().query("SELECT kind, retired_at IS NOT NULL AS retired FROM conversation_sessions WHERE id = $1", [ended!.applicationSessionId]);
    expect(session.rows).toEqual([{ kind: "background", retired: true }]);
    const events = await database().query("SELECT kind FROM background_task_events WHERE task_id = $1", [task.id]);
    expect(events.rows).toEqual([{ kind: "outcome" }]);
  });

  it("waits for an answer without a place, and continues with the answer in a new turn", async () => {
    const task = await createTestTask(fixture);
    const { dispatcher, model } = harness(
      toolCalls([{ id: "q1", input: { question: "Считать допсоглашения отдельно?" }, name: "ask_person" }]),
      reply("Спросил, жду ответа"),
      reply("Готово с учётом ответа"),
    );
    await run(dispatcher);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ state: "waiting_answer", waitingQuestion: "Считать допсоглашения отдельно?" });
    expect(await backgroundTaskMessageRepository.append({
      authorUserId: fixture.userId, createdByCallId: "m1", createdByTurnId: "main-turn", now: new Date(), taskId: task.id, text: "Отдельно",
    })).toBe("resumes");
    await run(dispatcher);
    expect(requestText(model.requests[2]!)).toContain("Отдельно");
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeText: "Готово с учётом ответа", state: "finished" });
  });

  it("stops on request: the step under way is cut and the summary says what was done", async () => {
    const task = await createTestTask(fixture);
    const hanging = hangingStep();
    const { dispatcher } = harness(hanging.step, reply("Успел разобрать 14 файлов из 31"));
    await dispatcher.pass();
    await hanging.called;
    expect(await backgroundTaskRepository.requestStop(task.id, new Date())).toBe("stopping");
    await dispatcher.idle();
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({
      outcomeCode: "AGENT_BACKGROUND_TASK_STOPPED", outcomeText: "Успел разобрать 14 файлов из 31", state: "stopped",
    });
  });

  it("falls back to the journal when the summary turn fails", async () => {
    const task = await createTestTask(fixture);
    const hanging = hangingStep();
    const { dispatcher } = harness(hanging.step, () => { throw new Error("TEST_MODEL_DOWN"); });
    await dispatcher.pass();
    await hanging.called;
    await backgroundTaskRepository.requestStop(task.id, new Date());
    await dispatcher.idle();
    const ended = await backgroundTaskRepository.find(task.id);
    expect(ended?.state).toBe("stopped");
    expect(ended?.outcomeText).toContain("could not write a summary");
  });

  it("cuts a hanging step when the hour runs out", async () => {
    const task = await createTestTask(fixture);
    await database().query("UPDATE background_tasks SET active_ms = $2 WHERE id = $1", [task.id, BACKGROUND_TASK_ACTIVE_LIMIT_MS - 200]);
    const hanging = hangingStep();
    const { dispatcher } = harness(hanging.step, reply("Не уложилась, успела половину"));
    await run(dispatcher);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeCode: "AGENT_BACKGROUND_TASK_TIME_LIMIT", state: "limit_time" });
  });

  it("stops at the hundredth step before the model is paid again", async () => {
    const task = await createTestTask(fixture);
    await database().query("UPDATE background_tasks SET steps = $2 WHERE id = $1", [task.id, BACKGROUND_TASK_STEP_LIMIT]);
    const { dispatcher, model } = harness(reply("Сводка: дошла до сотого шага"));
    await run(dispatcher);
    expect(model.requests).toHaveLength(1);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({
      outcomeText: "Сводка: дошла до сотого шага", state: "limit_steps", steps: BACKGROUND_TASK_STEP_LIMIT,
    });
  });

  it("treats the runtime's cap on one turn's steps as the task's step limit", async () => {
    // The task reaches its hundredth step inside one turn, where the runtime's own cap stops the turn first.
    const task = await createTestTask(fixture);
    await database().query("UPDATE background_tasks SET steps = $2 WHERE id = $1", [task.id, BACKGROUND_TASK_STEP_LIMIT - 2]);
    const { dispatcher } = harnessWith(
      { maxModelSteps: 2 },
      toolCalls([{ id: "n1", input: {}, name: "noop" }]),
      toolCalls([{ id: "n2", input: {}, name: "noop" }]),
      reply("Не уложилась в шаги, успела разобрать половину"),
    );
    await run(dispatcher);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({
      outcomeCode: "AGENT_BACKGROUND_TASK_STEP_LIMIT", outcomeText: "Не уложилась в шаги, успела разобрать половину", state: "limit_steps",
    });
  });

  it("gives a correction that came with the final text one more turn", async () => {
    const task = await createTestTask(fixture);
    const { dispatcher, model } = harness(
      async () => {
        // The person's correction arrives while the task writes its final answer without a tool call.
        await backgroundTaskMessageRepository.append({
          authorUserId: fixture.userId, createdByCallId: "m1", createdByTurnId: "main", now: new Date(), taskId: task.id, text: "Только 2025 год",
        });
        return reply("Готово за все годы");
      },
      reply("Готово за 2025 год"),
    );
    await run(dispatcher);
    expect(requestText(model.requests[1]!)).toContain("Только 2025 год");
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeText: "Готово за 2025 год", state: "finished" });
  });

  it("ends a summary a restart interrupted with the reason stored before it", async () => {
    const task = await createTestTask(fixture);
    const claimed = await backgroundTaskRepository.claimNextQueued(3, new Date());
    await backgroundTaskRepository.markSummary(task.id, "limit_steps", new Date());
    const access = await loadBackgroundTaskAccess(claimed!);
    await createBackgroundTaskTurn(database(), { access: access!, now: new Date(), purpose: { kind: "summary", reason: "limit_steps" }, task: claimed! });
    const { dispatcher, model } = harness(reply("Сводка после перезапуска"));
    await run(dispatcher);
    expect(model.requests).toHaveLength(1);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeText: "Сводка после перезапуска", state: "limit_steps" });
  });

  it("stops a task whose author lost access, before any model call", async () => {
    const task = await createTestTask(fixture);
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [fixture.userId]);
    const { dispatcher, model } = harness();
    await run(dispatcher);
    expect(model.requests).toHaveLength(0);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeCode: "AGENT_BACKGROUND_TASK_ACCESS_LOST", state: "stopped" });
  });

  it("continues the turn a previous process left, without starting another", async () => {
    const task = await createTestTask(fixture);
    const claimed = await backgroundTaskRepository.claimNextQueued(3, new Date());
    const access = await loadBackgroundTaskAccess(claimed!);
    const { turnId } = await createBackgroundTaskTurn(database(), { access: access!, now: new Date(), purpose: { kind: "start" }, task: claimed! });
    const { dispatcher, model } = harness(reply("Готово после перезапуска"));
    await run(dispatcher);
    expect(model.requests).toHaveLength(1);
    const turns = await database().query("SELECT id FROM agent_turns WHERE kind = 'background'");
    expect(turns.rows).toEqual([{ id: turnId }]);
    expect(await backgroundTaskRepository.find(task.id)).toMatchObject({ outcomeText: "Готово после перезапуска", state: "finished" });
  });

  it("starts nothing while a deploy prepares", async () => {
    const task = await createTestTask(fixture);
    phase = "draining";
    const { dispatcher, model } = harness();
    await run(dispatcher);
    expect(model.requests).toHaveLength(0);
    expect((await backgroundTaskRepository.find(task.id))?.state).toBe("queued");
  });
});
