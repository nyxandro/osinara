/**
 * Running turns: the one place every channel, schedule and recovery starts a turn through.
 *
 * Export:
 * - `createTurnDispatcher`: `run` runs a created turn to its end and returns its outcome; `start`
 *   does the same in the background under the deploy admission; `recover` resumes, at process
 *   start, the turns an earlier process left running; `idle` waits for background runs.
 *
 * A session's turns run one at a time, in creation order (`claimTurn`), so a turn created while an
 * earlier one runs waits for it, as Eve's `queue` turn policy did. A turn this process already
 * runs is joined, never run twice. A turn that already ended returns its stored outcome. Child
 * turns are never started here: their parent turn drives them.
 */
import { loadStep, loadTurn, listRunningRootTurns, releaseOtherRunners } from "./turn/journal-repository.js";
import { runTurn, type TurnOutcome, type TurnRuntime } from "./turn/run-turn.js";
import type { SubagentInputRequest, TurnRecord } from "./turn/turn-types.js";
import type { InputRequest } from "./hitl/types.js";

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

async function storedOutcome(runtime: TurnRuntime, turn: TurnRecord): Promise<TurnOutcome> {
  switch (turn.status) {
    case "completed":
      return { status: "completed", text: turn.finalText };
    case "failed":
      return { code: turn.errorCode!, message: turn.errorMessage!, status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
    case "waiting_input": {
      const recorded = await loadStep(runtime.database, turn.id, turn.nextStepIndex);
      const awaiting = recorded?.calls.filter((call) => call.state === "awaiting_input" && call.inputRequest !== null) ?? [];
      const own = awaiting.flatMap((call) => call.inputRequest!.kind === "subagent" ? [] : [call.inputRequest as InputRequest]);
      const proxied = awaiting.flatMap((call) => call.inputRequest!.kind === "subagent" ? (call.inputRequest as SubagentInputRequest).requests : []);
      return { requests: [...own, ...proxied], status: "waiting_input" };
    }
    case "running":
      throw new Error(`AGENT_TURN_STILL_RUNNING: turn ${turn.id} has no outcome yet`);
  }
}

export function createTurnDispatcher(input: {
  readonly admit: RuntimeAdmission;
  readonly runtime: TurnRuntime;
  /** How often a waiting turn checks again when no in-process run signals that its session moved on. */
  readonly waitMilliseconds: number;
}): TurnDispatcher {
  const { runtime } = input;
  const active = new Map<string, Promise<TurnOutcome>>();
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
      if (turn.status !== "running") return await storedOutcome(runtime, turn);
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

  function start(turnId: string): void {
    const work = (async () => {
      try {
        const ran = await input.admit(() => run(turnId));
        if (ran === null) console.info(JSON.stringify({ code: "AGENT_TURN_DEFERRED_BY_MAINTENANCE", turnId }));
      } catch (error) {
        // The background run is the boundary: nobody awaits it, so its failure is logged here once.
        console.error(JSON.stringify({
          code: "AGENT_TURN_BACKGROUND_RUN_FAILED",
          error: error instanceof Error ? error.message : String(error),
          turnId,
        }));
      }
    })();
    background.add(work);
    void work.finally(() => background.delete(work));
  }

  async function recover(): Promise<number> {
    await releaseOtherRunners(runtime.database, runtime.runnerId);
    const turns = await listRunningRootTurns(runtime.database);
    for (const turn of turns) start(turn.id);
    if (turns.length > 0) console.info(JSON.stringify({ code: "AGENT_TURNS_RECOVERED", count: turns.length }));
    return turns.length;
  }

  async function idle(): Promise<void> {
    while (background.size > 0) await Promise.allSettled([...background]);
  }

  return { idle, recover, run, start };
}
