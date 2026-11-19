/**
 * Runs background tasks: up to three at once, each within its hour and its hundred steps (#519).
 *
 * Exports:
 * - `BackgroundTaskDispatcherDependencies`: the runtime the turns run in, the clock and the cadence.
 * - `createBackgroundTaskDispatcher`: a loop that starts queued tasks while a place is free, takes over
 *   running tasks nobody here works on, and ends tasks whose question waited a day.
 *
 * Key constructs:
 * - A task's turns run on the dispatcher's own signal, never under the deploy admission: a deploy neither
 *   waits for a task nor is held by one. A restart cuts the step under way; the task is taken over again
 *   and its turn goes on from the journal. The runtime's recovery leaves these turns alone.
 * - The signal fires when the person stops the task (seen within a few seconds) or the hour runs out. The
 *   hundredth step is enforced before the model is paid (`recordBackgroundTaskStep`). A task cut off
 *   gets one short summary turn without tools; when that fails, the journal says what it did last.
 * - Before every turn the author's rights are checked again; a lost right stops the task.
 * - While a deploy prepares (phase other than `ready`) no turn starts: the task waits for its turn.
 * - When a task ends, its browser in the chat's sandbox is closed (#529), after its place is freed; a failed
 *   close is logged and changes nothing in the outcome. A task waiting for an answer is not cleaned up: its
 *   browser closes by agent-browser's own idle timeout.
 */
import type { Pool } from "pg";

import type { TurnOutcome, TurnRuntime } from "../../runtime/turn/run-turn.js";
import { isAppError } from "../app-error.js";
import { isDatabaseUnavailable, waitForApplicationDatabase } from "../database-recovery.js";
import { loadBackgroundTaskAccess } from "./background-task-access.js";
import {
  BACKGROUND_TASK_ACTIVE_LIMIT_MS,
  BACKGROUND_TASK_ANSWER_WAIT_MS,
  BACKGROUND_TASK_CONCURRENCY,
  BACKGROUND_TASK_STEP_LIMIT,
  BACKGROUND_TASK_SUMMARY_TIMEOUT_MS,
  BACKGROUND_TASK_TEXT_MAX_LENGTH,
} from "./background-task-config.js";
import { journalOutcomeText, lastBackgroundTaskTools } from "./background-task-journal.js";
import { activeMsAt, isActiveState, type BackgroundTask } from "./background-task-records.js";
import { backgroundTaskRepository, type BackgroundTaskOutcome } from "./background-task-repository.js";
import {
  createBackgroundTaskTurn,
  runBackgroundTaskTurn,
  type BackgroundTaskSummaryReason,
} from "./background-task-turn.js";

export interface BackgroundTaskDispatcherDependencies {
  /** Closes the ended task's browser sessions in its chat's sandbox (`closeBackgroundTaskBrowser`). */
  readonly closeTaskBrowser: (task: BackgroundTask) => Promise<void>;
  /** The runner lock: a process that lost it to another must not take tasks over (`RunnerLock.ensureHeld`). */
  readonly holdsRunnerLock: () => Promise<boolean>;
  readonly now: () => Date;
  /** How often the loop looks for work, and how soon a stop request cuts the step under way. */
  readonly pollMilliseconds: number;
  readonly readPhase: () => Promise<string>;
  readonly runtime: TurnRuntime & { readonly database: Pick<Pool, "query"> };
}

const OUTCOME_CODES: Readonly<Record<BackgroundTaskSummaryReason, string>> = {
  limit_steps: "AGENT_BACKGROUND_TASK_STEP_LIMIT",
  limit_time: "AGENT_BACKGROUND_TASK_TIME_LIMIT",
  stopped: "AGENT_BACKGROUND_TASK_STOPPED",
};
const LAST_TOOLS_IN_OUTCOME = 5;
// The runtime's own cap on steps of one turn: reached by a task within one turn, it is the task's limit too.
const TURN_STEP_LIMIT_CODE = "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED";

type Outcome = { readonly code: string; readonly state: BackgroundTaskOutcome["state"]; readonly text: string | null };

function log(code: string, fields: Record<string, unknown>, level: "error" | "info" | "warn" = "info"): void {
  console[level](JSON.stringify({ code, ...fields }));
}

/** Files the final answer names inside the task's folder, in the order it names them. */
export function outcomeFiles(text: string, taskId: string): string[] {
  const pattern = new RegExp(`/workspace/(?:personal|family)/background/${taskId}/[^\\s"'\`<>)\\]]+`, "gu");
  // Punctuation after a path ends the sentence, not the path; trimmed before the paths are compared.
  return [...new Set((text.match(pattern) ?? []).map((path) => path.replace(/[.,;:]+$/u, "")))];
}

function bounded(text: string): string {
  return text.length <= BACKGROUND_TASK_TEXT_MAX_LENGTH ? text : `${text.slice(0, BACKGROUND_TASK_TEXT_MAX_LENGTH - 1)}…`;
}

export function createBackgroundTaskDispatcher(dependencies: BackgroundTaskDispatcherDependencies) {
  const { runtime } = dependencies;
  const tasks = backgroundTaskRepository;
  const working = new Map<string, Promise<void>>();
  // Every task's run up to its browser cleanup, which goes on after the place is freed; `idle` waits for it.
  const runs = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function outcomeInput(task: BackgroundTask, outcome: Outcome): BackgroundTaskOutcome {
    return {
      code: outcome.code,
      files: outcome.text === null ? [] : outcomeFiles(outcome.text, task.id),
      id: task.id,
      now: dependencies.now(),
      state: outcome.state,
      text: outcome.text === null ? null : bounded(outcome.text),
    };
  }

  function logFinished(ended: BackgroundTask | null): void {
    if (ended === null) return;
    log("AGENT_BACKGROUND_TASK_FINISHED", { activeMs: ended.activeMs, outcome: ended.state, outcomeCode: ended.outcomeCode, steps: ended.steps, taskId: ended.id });
  }

  async function finish(task: BackgroundTask, outcome: Outcome): Promise<void> {
    logFinished(await tasks.finish(outcomeInput(task, outcome)));
  }

  /**
   * The short turn that says what a cut-off task managed; the journal speaks when it cannot. The reason is
   * stored first, so a summary turn a restart interrupted (`summaryTurnId`) ends with the same outcome.
   */
  async function summarize(task: BackgroundTask, cut: BackgroundTaskSummaryReason, summaryTurnId: string | null = null): Promise<void> {
    const reason = await tasks.markSummary(task.id, cut, dependencies.now());
    // The task ended meanwhile elsewhere: its outcome is already written.
    if (reason === null) return;
    const access = await loadBackgroundTaskAccess(task);
    let text: string | null = null;
    if (access !== null) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), BACKGROUND_TASK_SUMMARY_TIMEOUT_MS);
      try {
        const turnId = summaryTurnId
          ?? (await createBackgroundTaskTurn(runtime.database, { access, now: dependencies.now(), purpose: { kind: "summary", reason }, task })).turnId;
        const outcome = await runBackgroundTaskTurn(runtime, turnId, controller.signal);
        if (outcome.status === "completed" && outcome.text) text = outcome.text;
      } catch (error) {
        // Recovery path: the outcome still goes out, from the journal instead of the task's own words.
        log("AGENT_BACKGROUND_TASK_SUMMARY_FAILED", { error: error instanceof Error ? error.message : String(error), taskId: task.id }, "error");
      } finally {
        clearTimeout(deadline);
      }
    }
    if (text === null) {
      const current = await tasks.find(task.id);
      text = journalOutcomeText(await lastBackgroundTaskTools(runtime.database, current?.agentSessionId ?? task.agentSessionId, LAST_TOOLS_IN_OUTCOME));
    }
    await finish(task, { code: OUTCOME_CODES[reason], state: reason, text });
  }

  /** Why a turn of a running task was cut, read from the task after it. */
  function cutReason(task: BackgroundTask, timedOut: boolean): BackgroundTaskSummaryReason | null {
    if (task.state === "stopping") return "stopped";
    if (task.steps >= BACKGROUND_TASK_STEP_LIMIT) return "limit_steps";
    if (timedOut || activeMsAt(task, dependencies.now()) >= BACKGROUND_TASK_ACTIVE_LIMIT_MS) return "limit_time";
    return null;
  }

  async function settle(task: BackgroundTask, outcome: TurnOutcome): Promise<"continue" | "done"> {
    if (task.waitingQuestion !== null) {
      const waiting = await tasks.waitForAnswer(task.id, dependencies.now());
      // A message came after the question (often its answer): the task goes on with it at once.
      if (waiting === "messages_pending") return "continue";
      if (waiting !== null) log("AGENT_BACKGROUND_TASK_QUESTION", { questionSeq: waiting.questionSeq, taskId: task.id });
      return "done";
    }
    if (outcome.status === "completed") {
      // A correction the turn never saw gets one more turn, so the outcome takes it into account.
      const ended = await tasks.finishUnlessMessages(outcomeInput(task, { code: "AGENT_BACKGROUND_TASK_FINISHED", state: "finished", text: outcome.text ?? "" }));
      if (ended === "messages_pending") return "continue";
      logFinished(ended);
    } else if (outcome.status === "failed") {
      await finish(task, { code: outcome.code.startsWith("AGENT_") ? outcome.code : "AGENT_BACKGROUND_TASK_FAILED", state: "failed", text: null });
    } else if (outcome.status === "waiting_input") {
      await finish(task, { code: "AGENT_BACKGROUND_TASK_NEEDS_PERSON", state: "failed", text: null });
    } else {
      await finish(task, { code: "AGENT_BACKGROUND_TASK_CANCELLED", state: "failed", text: null });
    }
    return "done";
  }

  async function work(initial: BackgroundTask): Promise<void> {
    let task = initial;
    // A turn left by a previous process (or before a deploy) goes on first; a stopping one is closed.
    let pendingTurnId = task.currentTurnId;
    for (;;) {
      if (await dependencies.readPhase() !== "ready") {
        await tasks.pauseClock(task.id, dependencies.now());
        return;
      }
      // A summary a restart interrupted: it goes on, or starts again, with the reason stored before it.
      if (task.summaryReason !== null) {
        await summarize(task, task.summaryReason, pendingTurnId);
        return;
      }
      // Stopped between two turns: no turn to cut, only the summary is left.
      if (task.state === "stopping" && pendingTurnId === null) {
        await summarize(task, "stopped");
        return;
      }
      const access = await loadBackgroundTaskAccess(task);
      if (access === null) {
        log("AGENT_BACKGROUND_TASK_ACCESS_LOST", { taskId: task.id });
        await finish(task, { code: "AGENT_BACKGROUND_TASK_ACCESS_LOST", state: "stopped", text: null });
        return;
      }
      const controller = new AbortController();
      let timedOut = false;
      const remaining = Math.max(0, BACKGROUND_TASK_ACTIVE_LIMIT_MS - activeMsAt(task, dependencies.now()));
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
      if (task.state === "stopping") controller.abort();
      const watch = setInterval(() => {
        void tasks.find(task.id).then((current) => {
          if (current?.state !== "running") controller.abort();
        }, (error: unknown) => log("AGENT_BACKGROUND_TASK_WATCH_FAILED", { error: error instanceof Error ? error.message : String(error), taskId: task.id }, "error"));
      }, dependencies.pollMilliseconds);
      let outcome: TurnOutcome;
      try {
        const turnId = pendingTurnId ?? (await createBackgroundTaskTurn(runtime.database, {
          access, now: dependencies.now(), purpose: task.agentSessionId === null ? { kind: "start" } : { kind: "continue" }, task,
        })).turnId;
        pendingTurnId = null;
        outcome = await runBackgroundTaskTurn(runtime, turnId, controller.signal);
      } finally {
        clearTimeout(deadline);
        clearInterval(watch);
      }
      const after = await tasks.find(task.id);
      // Ended meanwhile elsewhere, or erased with its family group: nothing is left to do here.
      if (after === null || (after.state !== "running" && after.state !== "stopping")) return;
      task = after;
      // Cut by the dispatcher's signal, by the task's step count, or by the runtime's cap on one turn's steps.
      const cut = controller.signal.aborted || outcome.status === "cancelled" ||
        (outcome.status === "failed" && outcome.code === TURN_STEP_LIMIT_CODE);
      if (cut) {
        const reason = cutReason(task, timedOut);
        if (reason !== null) {
          await summarize(task, reason);
          return;
        }
      }
      if (await settle(task, outcome) === "done") return;
    }
  }

  /** Cleanup never fails the task: its outcome is written already, and the browser closes by idle anyway. */
  async function closeBrowserIfEnded(taskId: string): Promise<void> {
    try {
      const current = await tasks.find(taskId);
      if (current === null || isActiveState(current.state)) return;
      await dependencies.closeTaskBrowser(current);
    } catch (error) {
      log("AGENT_BACKGROUND_TASK_BROWSER_CLOSE_FAILED", { error: error instanceof Error ? error.message : String(error), taskId }, "error");
    }
  }

  function begin(task: BackgroundTask, code: string): void {
    log(code, { taskId: task.id });
    const run = (async () => {
      try {
        await work(task);
      } catch (error) {
        // The database away for a moment is not the task's failure: it stays running, and the next pass
        // takes it over once the database is back.
        if (isDatabaseUnavailable(error)) {
          log("AGENT_BACKGROUND_TASK_DATABASE_UNAVAILABLE", { error: error instanceof Error ? error.message : String(error), taskId: task.id }, "warn");
          await waitForApplicationDatabase();
          return;
        }
        // The task's own boundary: nobody awaits it. A task that cannot go on ends as failed, so its chat
        // hears about it; if even that fails, the next pass takes it over again.
        const errorCode = isAppError(error) ? error.code : "AGENT_BACKGROUND_TASK_FAILED";
        log("AGENT_BACKGROUND_TASK_DISPATCH_FAILED", { error: error instanceof Error ? error.message : String(error), errorCode, taskId: task.id }, "error");
        await finish(task, { code: errorCode, state: "failed", text: null }).catch((finishError: unknown) => log(
          "AGENT_BACKGROUND_TASK_FINISH_FAILED", { error: finishError instanceof Error ? finishError.message : String(finishError), taskId: task.id }, "error",
        ));
      } finally {
        working.delete(task.id);
      }
      // The place is free already: an ended task is never taken over again, so a slow close holds no one up.
      await closeBrowserIfEnded(task.id);
    })();
    working.set(task.id, run);
    runs.add(run);
    // `finally` keeps an unexpected rejection of the run as loud as before: nothing here swallows it.
    void run.finally(() => runs.delete(run));
  }

  async function pass(): Promise<void> {
    if (await dependencies.readPhase() !== "ready") return;
    // Another process took the runtime over: its own dispatcher works on the tasks now.
    if (!await dependencies.holdsRunnerLock()) return;
    const now = dependencies.now();
    await tasks.expireUnanswered(now, BACKGROUND_TASK_ANSWER_WAIT_MS);
    for (const task of await tasks.adoptRunning(now, [...working.keys()])) begin(task, "AGENT_BACKGROUND_TASK_RESUMED");
    while (!stopped && working.size < BACKGROUND_TASK_CONCURRENCY) {
      const task = await tasks.claimNextQueued(BACKGROUND_TASK_CONCURRENCY, dependencies.now());
      if (task === null) return;
      begin(task, "AGENT_BACKGROUND_TASK_STARTED");
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void pass()
        .catch((error: unknown) => log("AGENT_BACKGROUND_TASK_PASS_FAILED", { error: error instanceof Error ? error.message : String(error) }, "error"))
        .finally(schedule);
    }, dependencies.pollMilliseconds);
  }

  return {
    start(): void {
      stopped = false;
      schedule();
    },
    /** No new passes; running turns are left to the process's end, as the runtime leaves its own. */
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
    /** For tests: waits for every task this process works on. */
    async idle(): Promise<void> {
      while (runs.size > 0) await Promise.allSettled([...runs]);
    },
    pass,
  };
}
