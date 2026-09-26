/**
 * Chat-queue processing of wake-ups that run inside the chat's own conversation.
 *
 * Exports:
 * - `ConversationWakeupDrainDependencies`: queue repository, session access, shared turn slots.
 * - `createConversationWakeupProcessor`: processes at most one wake-up per call.
 *
 * Key constructs:
 * - A wake-up runs on its own model-turn slot, never on a message's, and is claimed only with that
 *   slot already free: a claimed wake-up closes its chat's lane, so it must not wait for a slot.
 * - The turn is handed over and observed exactly like a Telegram message: its events carry this
 *   dispatch's mark, Eve refuses to start it after its admission deadline, and a lost observer
 *   cancels the turn before the lane opens again.
 * - A wake-up reclaimed after its handoff is observed from its stored start and never sent again.
 *   Until its admission deadline its turn may still start; one that has not started by then never
 *   will, and the wake-up is parked instead.
 */
import type { Session } from "eve/channels";

import { AGENT_SCHEDULE_CONVERSATION_ADMISSION_MARGIN_MILLISECONDS } from "../agent-schedules/agent-schedule-config.js";
import { AppError, isAppError } from "../app-error.js";
import { isDatabaseUnavailable, waitForApplicationDatabase } from "../database-recovery.js";
import { runTelegramProcessing } from "../telegram-processing-deadline.js";
import { type BoundaryEvent, waitForSessionBoundary } from "../telegram-session-boundary.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import type {
  ConversationWakeupClaim,
  ConversationWakeupDispatch,
  conversationWakeupRepository,
} from "./conversation-wakeup-repository.js";
import {
  CONVERSATION_CHANGED_CODE,
  WAKEUP_HANDOFF_FAILED_CODE,
  WAKEUP_LEASE_LOST_CODE,
  WAKEUP_NOT_STARTED_CODE,
} from "./conversation-wakeup-transitions.js";
import {
  conversationCanonicalRouteToken,
  conversationWakeupAuth,
  conversationWakeupMessage,
} from "./conversation-wakeup-turn.js";

const LEASE_HEARTBEAT_DIVISOR = 3;
const SESSION_INACTIVE_CODE = "AGENT_CONVERSATION_WAKEUP_SESSION_INACTIVE";

type WakeupSession = Pick<Session, "cancel" | "getEventStream" | "id" | "send">;
type SendResult = Awaited<ReturnType<Session["send"]>>;

export interface ConversationWakeupDrainDependencies {
  admissionMilliseconds: number;
  attachSession(sessionId: string): WakeupSession;
  cancellationMilliseconds: number;
  leaseMilliseconds: number;
  now(): Date;
  observerIdleMilliseconds: number;
  readCursor(eveSessionId: string): Promise<number>;
  repository: Pick<
    typeof conversationWakeupRepository,
    "admittedTurn" | "claimNext" | "complete" | "fail" | "markDispatched" | "prepare" | "renewLease" | "withdrawNotStarted"
  >;
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

async function dispatch(
  dependencies: ConversationWakeupDrainDependencies,
  claim: ConversationWakeupClaim,
  wakeup: PreparedConversationWakeup,
  signal: AbortSignal,
): Promise<void> {
  const now = dependencies.now();
  const { context, message } = conversationWakeupMessage(wakeup, now);
  const nextEventIndex = await runTelegramProcessing({
    cancellationMilliseconds: dependencies.cancellationMilliseconds,
    readCursor: dependencies.readCursor,
    signal,
    timeoutMilliseconds: dependencies.admissionMilliseconds,
    execute: async (control) => {
      const startIndex = await dependencies.repository.markDispatched(claim, wakeup.eveSessionId, {
        admissionDeadlineAt: new Date(control.deadlineAt),
        id: control.dispatchId,
      });
      control.signal.throwIfAborted();
      const session = dependencies.attachSession(wakeup.eveSessionId);
      const auth = conversationWakeupAuth(wakeup, now, { deadlineAt: control.deadlineAt, id: control.dispatchId });
      let sent: SendResult;
      try {
        sent = await session.send(message, { auth, context, turnPolicy: "queue" });
      } catch (error) {
        console.error(JSON.stringify({ code: WAKEUP_HANDOFF_FAILED_CODE, error: errorMessage(error), runId: claim.runId, wakeupId: claim.id }));
        throw new AppError(WAKEUP_HANDOFF_FAILED_CODE, "Не удалось передать пробуждение в разговор");
      }
      if (sent.status !== "accepted") {
        throw new AppError(SESSION_INACTIVE_CODE, "Разговор пробуждения больше не ведётся");
      }
      control.observeSession(session);
      control.signal.throwIfAborted();
      return await waitForSessionBoundary(session, startIndex, dependencies.observerIdleMilliseconds, {
        accepts: control.acceptsEvent,
        idle: true,
      });
    },
  });
  await dependencies.repository.complete(claim, wakeup.eveSessionId, nextEventIndex);
}

/** Session-level boundaries and events of this dispatch, as the message observer accepts them. */
function ofDispatch(dispatchId: string) {
  return (event: BoundaryEvent) => event.type === "session.failed" || event.type === "session.completed" ||
    event.data?.osinaraTelegramIngressId === dispatchId;
}

/**
 * The boundary a handed-off turn reached before its admission deadline, or null if none did. A lost
 * lease ends the wait at once: the wake-up slot is shared by every chat.
 */
async function boundaryBeforeDeadline(
  session: WakeupSession,
  handoff: ConversationWakeupDispatch,
  signal: AbortSignal,
): Promise<number | null> {
  const remaining = handoff.admissionDeadlineAt.getTime() + AGENT_SCHEDULE_CONVERSATION_ADMISSION_MARGIN_MILLISECONDS - Date.now();
  if (remaining <= 0) return null;
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    // The reader closes itself at its own deadline if the wait is abandoned.
    return await Promise.race([
      waitForSessionBoundary(session, handoff.startIndex, remaining, { accepts: ofDispatch(handoff.id) }),
      aborted,
    ]);
  } catch (error) {
    if (isAppError(error) && error.code === "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT") return null;
    throw error;
  } finally {
    signal.removeEventListener("abort", stop!);
  }
}

async function recover(
  dependencies: ConversationWakeupDrainDependencies,
  claim: ConversationWakeupClaim,
  handoff: ConversationWakeupDispatch,
  signal: AbortSignal,
): Promise<void> {
  const session = dependencies.attachSession(handoff.eveSessionId);
  let turnId = claim.eveTurnId;
  if (turnId === null) {
    // Until its deadline Eve may still admit the turn, which may even finish meanwhile.
    const finished = await boundaryBeforeDeadline(session, handoff, signal);
    if (finished !== null) {
      await dependencies.repository.complete(claim, session.id, finished);
      return;
    }
    // Past the deadline no turn can start, and a late one finds no run to admit it.
    if (await dependencies.repository.withdrawNotStarted(claim, WAKEUP_NOT_STARTED_CODE)) {
      console.info(JSON.stringify({ code: WAKEUP_NOT_STARTED_CODE, runId: claim.runId, wakeupId: claim.id }));
      return;
    }
    turnId = (await dependencies.repository.admittedTurn(claim.runId)).eveTurnId;
  }
  const nextEventIndex = await runTelegramProcessing({
    cancellationMilliseconds: dependencies.cancellationMilliseconds,
    dispatchId: handoff.id,
    ...(turnId === null ? {} : { initialTurnId: turnId }),
    readCursor: dependencies.readCursor,
    signal,
    timeoutMilliseconds: dependencies.admissionMilliseconds,
    execute: async (control) => {
      control.observeSession(session);
      return await waitForSessionBoundary(session, handoff.startIndex, dependencies.observerIdleMilliseconds, {
        accepts: control.acceptsEvent,
        idle: true,
      });
    },
  });
  await dependencies.repository.complete(claim, session.id, nextEventIndex);
  console.info(JSON.stringify({ code: "AGENT_CONVERSATION_WAKEUP_RECOVERED", wakeupId: claim.id }));
}

async function run(
  dependencies: ConversationWakeupDrainDependencies,
  claim: ConversationWakeupClaim,
  signal: AbortSignal,
): Promise<void> {
  if (claim.dispatch !== null) return await recover(dependencies, claim, claim.dispatch, signal);
  const prepared = await dependencies.repository.prepare(claim, conversationCanonicalRouteToken);
  if (prepared.kind !== "ready") {
    console.info(JSON.stringify({ code: `AGENT_CONVERSATION_WAKEUP_${prepared.kind.toUpperCase()}`, runId: claim.runId, wakeupId: claim.id }));
    return;
  }
  await dispatch(dependencies, claim, prepared.wakeup, signal);
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
    // The lease expires on its own; a handed-off turn is then observed by the next claim.
    await waitForApplicationDatabase();
    return;
  }
  // Eve no longer runs this conversation and started nothing, so the chat has moved on.
  if (isAppError(error) && error.code === SESSION_INACTIVE_CODE &&
    await dependencies.repository.withdrawNotStarted(claim, CONVERSATION_CHANGED_CODE)) return;
  // A refused handoff may be transient. Without its run a turn that still arrives cannot start, so
  // the wake-up is parked where the agent sees it and can resume it, instead of failing for good.
  if (isAppError(error) && error.code === WAKEUP_HANDOFF_FAILED_CODE &&
    await dependencies.repository.withdrawNotStarted(claim, WAKEUP_HANDOFF_FAILED_CODE)) return;
  const failure = { code: errorCode(error), message: errorMessage(error) };
  console.error(JSON.stringify({ ...failure, runId: claim.runId, wakeupId: claim.id }));
  // The observer has already asked Eve to cancel the turn, and that turn's own terminal event
  // closes the run; the scheduler's sweep closes one that never reports.
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
        await run(dependencies, claim, controller.signal);
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
