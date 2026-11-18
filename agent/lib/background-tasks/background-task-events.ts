/**
 * Brings background tasks' questions and outcomes to their chats, on the wake-up slot (#519).
 *
 * Export:
 * - `createBackgroundTaskEventProcessor`: handles at most one due event per call; the chat ingress drain
 *   calls it after wake-ups, when no message waits.
 *
 * Key constructs:
 * - At least once: the event is answered only after the main agent's turn ended well. A failed or broken
 *   turn brings it back in five minutes, a bounded number of times; the last failure gives it up loudly.
 *   An unreachable model hub spends no attempt and is tried ever less often, up to a day after the event
 *   was ready. A failed turn whose answer may have reached the chat is not repeated: the event is closed.
 * - A turn an earlier attempt created is let finish, never created again: the person hears it once.
 * - A chat without a conversation right now (a new context nobody wrote into, a card waiting for an
 *   answer) keeps the event waiting without spending an attempt, up to a day.
 */
import type { Pool } from "pg";

import type { JournalDatabase } from "../../runtime/turn/journal-repository.js";
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import { isAppError } from "../app-error.js";
import { telegramFinalDeliveryRepository } from "../telegram-final-delivery-repository.js";
import { BACKGROUND_TASK_ANSWER_WAIT_MS, BACKGROUND_TASK_EVENT_LEASE_MS, BACKGROUND_TASK_EVENT_RETRY_MS } from "./background-task-config.js";
import { backgroundTaskEventRepository, type BackgroundTaskEvent } from "./background-task-event-repository.js";
import { createBackgroundTaskEventTurn, EVENT_CONVERSATION_IDLE_CODE, prepareBackgroundTaskEvent } from "./background-task-event-turn.js";

export interface BackgroundTaskEventDependencies {
  readonly database: JournalDatabase & Pick<Pool, "query">;
  readonly now: () => Date;
  /** Runs a turn to its end, or returns the outcome of one that already ended. */
  readonly runTurn: (turnId: string) => Promise<TurnOutcome>;
  readonly slots: { release(): void; tryAcquire(): unknown };
}

function log(code: string, event: BackgroundTaskEvent, fields: Record<string, unknown> = {}, level: "error" | "info" | "warn" = "info"): void {
  console[level](JSON.stringify({ code, eventId: event.id, kind: event.kind, taskId: event.task.id, ...fields }));
}

async function settle(event: BackgroundTaskEvent, turnId: string, outcome: TurnOutcome, now: Date): Promise<void> {
  // A turn that waits for a person's button has spoken: the event is answered.
  if (outcome.status === "completed" || outcome.status === "waiting_input") {
    if (await backgroundTaskEventRepository.answer(event, now)) log("AGENT_BACKGROUND_TASK_EVENT_ANSWERED", event);
    return;
  }
  const code = outcome.status === "failed" ? outcome.code : "AGENT_BACKGROUND_TASK_EVENT_TURN_CANCELLED";
  // The retelling may have reached the chat (delivered, an unknown outcome, a part sent): telling it again
  // could repeat it, and an unknown outcome is no leave to retry (17.11.2026 a 504 told an outcome twice).
  // The outcome stays in the task's record, and the person can ask for it.
  if (await telegramFinalDeliveryRepository.mayHaveReachedChat(turnId) || await backgroundTaskEventRepository.sentToChatByTool(turnId)) {
    if (await backgroundTaskEventRepository.answer(event, now)) {
      log("AGENT_BACKGROUND_TASK_EVENT_DELIVERY_UNCONFIRMED", event, { lastErrorCode: code, turnId }, "warn");
    }
    return;
  }
  await retry(event, code, now);
}

// The hub could not be reached or did not start answering: the same prompt goes through once it is back.
const HUB_OUT_CODES: ReadonlySet<string> = new Set(["AGENT_MODEL_TEMPORARILY_UNAVAILABLE", "AGENT_MODEL_FIRST_CHUNK_TIMEOUT"]);
const HUB_OUT_PAUSE_MAX_MS = 60 * 60_000;

/** `keepsTurn`: the turn this attempt made, if any, is asked again next time instead of being replaced. */
async function retry(event: BackgroundTaskEvent, code: string, now: Date, keepsTurn = false): Promise<void> {
  if (HUB_OUT_CODES.has(code)) {
    // The hub can be out for an hour (17.11.2026), as long as all the attempts last. Such a failure spends
    // none, as an idle chat does, and is tried ever less often — the pause is as long as the wait so far, up
    // to an hour — until a day after the outcome was ready.
    const waited = now.getTime() - event.createdAt.getTime();
    if (waited >= BACKGROUND_TASK_ANSWER_WAIT_MS) {
      if (await backgroundTaskEventRepository.giveUp(event, code)) log("AGENT_BACKGROUND_TASK_EVENT_GAVE_UP", event, { lastErrorCode: code }, "error");
      return;
    }
    const pauseMs = Math.min(Math.max(BACKGROUND_TASK_EVENT_RETRY_MS, waited), HUB_OUT_PAUSE_MAX_MS);
    if (await backgroundTaskEventRepository.retry(event, code, now, { keepsTurn, pauseMs, spendsAttempt: false }) === "retry") {
      log("AGENT_BACKGROUND_TASK_EVENT_RETRY", event, { attempt: event.attemptCount, attemptSpent: false, lastErrorCode: code, pauseMs }, "warn");
    }
    return;
  }
  const result = await backgroundTaskEventRepository.retry(event, code, now, { keepsTurn, pauseMs: BACKGROUND_TASK_EVENT_RETRY_MS, spendsAttempt: true });
  if (result === "gave_up") log("AGENT_BACKGROUND_TASK_EVENT_GAVE_UP", event, { lastErrorCode: code }, "error");
  else if (result === "retry") log("AGENT_BACKGROUND_TASK_EVENT_RETRY", event, { attempt: event.attemptCount + 1, attemptSpent: true, lastErrorCode: code }, "warn");
}

async function handle(dependencies: BackgroundTaskEventDependencies, event: BackgroundTaskEvent): Promise<void> {
  if (event.turnId !== null) {
    await settle(event, event.turnId, await dependencies.runTurn(event.turnId), dependencies.now());
    return;
  }
  // The person answered before the question reached the chat (the task's line in the context shows it):
  // there is nothing left to ask.
  if (event.kind === "question" && (event.task.state !== "waiting_answer" || event.task.questionSeq !== event.questionSeq)) {
    if (await backgroundTaskEventRepository.answer(event, dependencies.now())) log("AGENT_BACKGROUND_TASK_EVENT_SUPERSEDED", event);
    return;
  }
  const prepared = await prepareBackgroundTaskEvent(dependencies.database, event, dependencies.now());
  if (prepared.kind === "defer") {
    await backgroundTaskEventRepository.defer(event, prepared.code, dependencies.now());
    return;
  }
  if (prepared.kind === "give_up") {
    // Expected: the author left or the chat stayed silent for a day. The outcome stays in the task's record.
    if (await backgroundTaskEventRepository.giveUp(event, prepared.code)) log("AGENT_BACKGROUND_TASK_EVENT_DROPPED", event, { reason: prepared.code });
    return;
  }
  const turnId = await createBackgroundTaskEventTurn(dependencies.database, { event, now: dependencies.now(), prepared });
  await settle(event, turnId, await dependencies.runTurn(turnId), dependencies.now());
}

export function createBackgroundTaskEventProcessor(dependencies: BackgroundTaskEventDependencies) {
  return async function processNextBackgroundTaskEvent(): Promise<boolean> {
    if (dependencies.slots.tryAcquire() === undefined) return false;
    try {
      const event = await backgroundTaskEventRepository.claim(dependencies.now(), BACKGROUND_TASK_EVENT_LEASE_MS);
      if (event === null) return false;
      try {
        await handle(dependencies, event);
      } catch (error) {
        const code = isAppError(error) ? error.code : "AGENT_BACKGROUND_TASK_EVENT_FAILED";
        // The conversation went away between the check and the turn: wait for the next one, as above.
        if (code === EVENT_CONVERSATION_IDLE_CODE && await backgroundTaskEventRepository.defer(event, code, dependencies.now())) return true;
        log("AGENT_BACKGROUND_TASK_EVENT_FAILED", event, { error: error instanceof Error ? error.message : String(error), errorCode: code }, "error");
        // Handling broke, not necessarily the turn: one already made may have told the outcome. The next
        // attempt runs that turn again (it returns its stored outcome) and settles it, never replaces it.
        await retry(event, code, dependencies.now(), true);
      }
      return true;
    } finally {
      dependencies.slots.release();
    }
  };
}
