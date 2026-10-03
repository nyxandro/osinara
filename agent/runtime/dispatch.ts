/**
 * Running turns: the one place every channel, schedule and recovery starts a turn through.
 *
 * Export:
 * - `createTurnDispatcher`: `run` runs a created turn to its end and returns its outcome; `start`
 *   does the same in the background under the deploy admission; `recover` resumes the turns an
 *   earlier process left running, and any whose start the deploy admission refused, and reports
 *   the turns it left unreported (it is repeated every minute); `idle` waits for background work.
 *
 * A session's turns run one at a time, in creation order (`claimTurn`), so a turn created while an
 * earlier one runs waits for it, as Eve's `queue` turn policy did. A turn this process already
 * runs is joined, never run twice. A turn that already ended returns its stored outcome. Child
 * turns are never started here: their parent turn drives them.
 */
import type { RunnerLock } from "./runner-lock.js";
import {
  listRunningRootTurns, listUnobservedRootTurns, loadTurn, loadUnobservedTurn, releaseOtherRunners,
} from "./turn/journal-repository.js";
import { runTurn, type TurnOutcome, type TurnRuntime } from "./turn/run-turn.js";
import { reportUnobservedTurn, storedTurnOutcome } from "./turn/turn-observation.js";

export interface TurnDispatcher {
  run(turnId: string): Promise<TurnOutcome>;
  start(turnId: string): void;
  recover(): Promise<number>;
  idle(): Promise<void>;
}

/** Wraps background work so a deploy sees it as busy; `null` when maintenance refuses new work. */
export type RuntimeAdmission = <T>(work: () => Promise<T>) => Promise<T | null>;

// Turns are never aborted from outside: a stopping process leaves them running for recovery.
const NEVER_ABORTED = new AbortController().signal;

export function createTurnDispatcher(input: {
  readonly admit: RuntimeAdmission;
  /** Recovery takes over other processes' turns only while this process holds it. */
  readonly runnerLock: Pick<RunnerLock, "ensureHeld">;
  readonly runtime: TurnRuntime;
  /** How often a waiting turn checks again when no in-process run signals that its session moved on. */
  readonly waitMilliseconds: number;
}): TurnDispatcher {
  const { runtime } = input;
  const active = new Map<string, Promise<TurnOutcome>>();
  const reporting = new Set<string>();
  const sessionWaiters = new Map<string, Set<() => void>>();
  const background = new Set<Promise<void>>();

  function waitForSession(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = sessionWaiters.get(sessionId) ?? new Set();
      sessionWaiters.set(sessionId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) sessionWaiters.delete(sessionId);
        resolve();
      };
      const timer = setTimeout(done, input.waitMilliseconds);
      waiters.add(done);
    });
  }

  function sessionMoved(sessionId: string): void {
    for (const waiter of [...sessionWaiters.get(sessionId) ?? []]) waiter();
  }

  async function runUntilEnded(turnId: string): Promise<TurnOutcome> {
    for (;;) {
      const outcome = await runTurn(runtime, turnId, { abortSignal: NEVER_ABORTED });
      if (outcome.status !== "busy") return outcome;
      const turn = await loadTurn(runtime.database, turnId);
      if (turn.status !== "running") return await storedTurnOutcome(runtime.database, turn);
      await waitForSession(turn.sessionId);
    }
  }

  function run(turnId: string): Promise<TurnOutcome> {
    const joined = active.get(turnId);
    if (joined !== undefined) return joined;
    const running = (async () => {
      let sessionId: string | undefined;
      try {
        sessionId = (await loadTurn(runtime.database, turnId)).sessionId;
        return await runUntilEnded(turnId);
      } finally {
        active.delete(turnId);
        if (sessionId !== undefined) sessionMoved(sessionId);
      }
    })();
    active.set(turnId, running);
    return running;
  }

  function inBackground(turnId: string, failureCode: string, work: () => Promise<unknown>): void {
    const running = (async () => {
      try {
        const ran = await input.admit(work);
        if (ran === null) console.info(JSON.stringify({ code: "AGENT_TURN_DEFERRED_BY_MAINTENANCE", turnId }));
      } catch (error) {
        // The background work is the boundary: nobody awaits it, so its failure is logged here once.
        console.error(JSON.stringify({ code: failureCode, error: error instanceof Error ? error.message : String(error), turnId }));
      }
    })();
    background.add(running);
    void running.finally(() => background.delete(running));
  }

  function start(turnId: string): void {
    inBackground(turnId, "AGENT_TURN_BACKGROUND_RUN_FAILED", () => run(turnId));
  }

  function report(turnId: string): void {
    reporting.add(turnId);
    inBackground(turnId, "AGENT_TURN_REPORT_FAILED", async () => {
      try {
        const entry = await loadUnobservedTurn(runtime.database, turnId);
        // A run of this process reports its own turn: it marks the report before it lets the turn go.
        if (entry === null || active.has(turnId)) return false;
        await reportUnobservedTurn(runtime, entry);
        return true;
      } finally {
        reporting.delete(turnId);
      }
    });
  }

  async function recover(): Promise<number> {
    if (!await input.runnerLock.ensureHeld()) {
      // Another process took the database over while this one had lost its connection.
      console.error(JSON.stringify({ code: "AGENT_RUNTIME_SECOND_PROCESS", runnerId: runtime.runnerId }));
      return 0;
    }
    await releaseOtherRunners(runtime.database, runtime.runnerId);
    // Turns this process already runs or waits on are left alone; a repeated recovery is cheap.
    const turns = (await listRunningRootTurns(runtime.database)).filter((turn) => !active.has(turn.id));
    for (const turn of turns) start(turn.id);
    const unreported = (await listUnobservedRootTurns(runtime.database)).filter((id) => !active.has(id) && !reporting.has(id));
    for (const turnId of unreported) report(turnId);
    if (turns.length + unreported.length > 0) {
      console.info(JSON.stringify({ code: "AGENT_TURNS_RECOVERED", count: turns.length, unreported: unreported.length }));
    }
    return turns.length + unreported.length;
  }

  async function idle(): Promise<void> {
    while (background.size > 0) await Promise.allSettled([...background]);
  }

  return { idle, recover, run, start };
}
