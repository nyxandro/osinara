/**
 * Chat-queue processing of wake-ups that run inside the chat's own conversation.
 *
 * Exports:
 * - `ConversationWakeupDrainDependencies`: queue repository, turn creation and runner, shared slots.
 * - `createConversationWakeupProcessor`: processes at most one wake-up per call.
 *
 * Key constructs:
 * - A wake-up runs on its own model-turn slot, never on a message's, and is claimed only with that
 *   slot already free: a claimed wake-up closes its chat's lane, so it must not wait for a slot.
 * - The wake-up's turn is created in the conversation's session in one transaction with the
 *   wake-up's record of it, and the item closes when that turn ended. The turn carries the same
 *   admission deadline a Telegram message's turn does: one that has not started by then fails at
 *   start and parks the wake-up.
 * - A wake-up reclaimed after its turn was created lets that turn finish and never sends it again.
 */
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import { AppError, isAppError } from "../app-error.js";
import { isDatabaseUnavailable, waitForApplicationDatabase } from "../database-recovery.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import type { ConversationWakeupClaim, conversationWakeupRepository } from "./conversation-wakeup-repository.js";
import {
  CONVERSATION_CHANGED_CODE,
  WAKEUP_LEASE_LOST_CODE,
} from "./conversation-wakeup-transitions.js";
import { conversationCanonicalRouteToken } from "./conversation-wakeup-turn.js";
import { WAKEUP_SESSION_INACTIVE_CODE } from "./conversation-wakeup-turn-start.js";

const LEASE_HEARTBEAT_DIVISOR = 3;
const LEGACY_HANDOFF_CODE = "AGENT_CONVERSATION_WAKEUP_HANDOFF_UNRECOVERABLE";

export interface ConversationWakeupDrainDependencies {
  /** Creates the wake-up's turn with the wake-up's record of it (`conversation-wakeup-turn-start.ts`). */
  createTurn(claim: ConversationWakeupClaim, wakeup: PreparedConversationWakeup): Promise<string>;
  leaseMilliseconds: number;
  repository: Pick<
    typeof conversationWakeupRepository,
    "claimNext" | "complete" | "fail" | "prepare" | "renewLease" | "withdrawNotStarted"
  >;
  /** Runs a turn to its end, or returns the outcome of one that already ended. */
  runTurn(turnId: string): Promise<TurnOutcome>;
  slots: { release(): void; tryAcquire(): unknown };
}

function errorCode(error: unknown): string {
  return isAppError(error) ? error.code : "AGENT_CONVERSATION_WAKEUP_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function heartbeat(
  dependencies: ConversationWakeupDrainDependencies,
  claim: ConversationWakeupClaim,
  signal: AbortSignal,
): Promise<void> {
  const interval = Math.floor(dependencies.leaseMilliseconds / LEASE_HEARTBEAT_DIVISOR);
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, interval);
      signal.addEventListener("abort", done, { once: true });
    });
    if (signal.aborted) return;
    await dependencies.repository.renewLease(claim.id, claim.leaseToken, dependencies.leaseMilliseconds);
  }
}

async function run(dependencies: ConversationWakeupDrainDependencies, claim: ConversationWakeupClaim): Promise<void> {
  if (claim.dispatch !== null) {
    // A hand-off Eve took before this release has no turn here to finish.
    if (claim.dispatch.turnId === null) {
      throw new AppError(LEGACY_HANDOFF_CODE, "Пробуждение было передано прежней версии и не может быть продолжено");
    }
    await dependencies.runTurn(claim.dispatch.turnId);
    await dependencies.repository.complete(claim, claim.dispatch.eveSessionId);
    console.info(JSON.stringify({ code: "AGENT_CONVERSATION_WAKEUP_RECOVERED", wakeupId: claim.id }));
    return;
  }
  const prepared = await dependencies.repository.prepare(claim, conversationCanonicalRouteToken);
  if (prepared.kind !== "ready") {
    console.info(JSON.stringify({ code: `AGENT_CONVERSATION_WAKEUP_${prepared.kind.toUpperCase()}`, runId: claim.runId, wakeupId: claim.id }));
    return;
  }
  const turnId = await dependencies.createTurn(claim, prepared.wakeup);
  await dependencies.runTurn(turnId);
  await dependencies.repository.complete(claim, prepared.wakeup.eveSessionId);
}

async function settle(
  dependencies: ConversationWakeupDrainDependencies,
  claim: ConversationWakeupClaim,
  error: unknown,
): Promise<void> {
  if (isAppError(error) && error.code === WAKEUP_LEASE_LOST_CODE) {
    // Another processor reclaimed the item after its lease expired, or its refused turn removed it.
    console.info(JSON.stringify({ code: "AGENT_CONVERSATION_WAKEUP_OBSERVER_RELEASED", reason: errorMessage(error), wakeupId: claim.id }));
    return;
  }
  if (isDatabaseUnavailable(error)) {
    // The lease expires on its own; a created turn is then finished by the next claim.
    await waitForApplicationDatabase();
    return;
  }
  // The conversation no longer has a session and nothing was created, so the chat has moved on.
  if (isAppError(error) && error.code === WAKEUP_SESSION_INACTIVE_CODE &&
    await dependencies.repository.withdrawNotStarted(claim, CONVERSATION_CHANGED_CODE)) return;
  const failure = { code: errorCode(error), message: errorMessage(error) };
  console.error(JSON.stringify({ ...failure, runId: claim.runId, wakeupId: claim.id }));
  // A created turn closes the run itself when it ends; the scheduler's sweep closes one that never reports.
  await dependencies.repository.fail(claim, failure);
}

export function createConversationWakeupProcessor(dependencies: ConversationWakeupDrainDependencies) {
  return async function processNextConversationWakeup(): Promise<boolean> {
    if (dependencies.slots.tryAcquire() === undefined) return false;
    try {
      const claim = await dependencies.repository.claimNext(dependencies.leaseMilliseconds);
      if (!claim) return false;
      const controller = new AbortController();
      const renewal = heartbeat(dependencies, claim, controller.signal).catch((error: unknown) => {
        console.error(JSON.stringify({ code: "AGENT_CONVERSATION_WAKEUP_LEASE_RENEWAL_FAILED", error: errorMessage(error), wakeupId: claim.id }));
        controller.abort(error);
      });
      try {
        await run(dependencies, claim);
      } catch (error) {
        await settle(dependencies, claim, error);
      } finally {
        controller.abort();
        await renewal;
      }
      return true;
    } finally {
      dependencies.slots.release();
    }
  };
}
