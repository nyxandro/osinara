/**
 * Turn events for a channel that delivers nothing, such as the internal memory review.
 *
 * Exports:
 * - `lifecycleTurnObserver`: the application hears that a turn started and how it ended; step
 *   texts are not delivered anywhere. A request for a person fails the turn: nobody can answer it.
 * - `LifecycleTurnContext`, `LifecycleTurnEvents`: what the handlers receive.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { AppError } from "../../lib/app-error.js";
import type { SessionAuth, SessionTurn } from "../context.js";
import type { TurnObserver } from "./run-turn.js";
import type { TurnRecord } from "./turn-types.js";

export interface LifecycleTurnContext {
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
    readonly parent?: undefined;
    readonly turn: SessionTurn;
  };
}

export interface LifecycleTurnEvents {
  /** Before the turn's instructions are resolved; a failure stops the turn before any model call. */
  readonly "turn.started": (ctx: LifecycleTurnContext) => Promise<void>;
  readonly "turn.completed": (ctx: LifecycleTurnContext) => Promise<void>;
  readonly "turn.failed": (data: { readonly code: string; readonly message: string }, ctx: LifecycleTurnContext) => Promise<void>;
  readonly "turn.cancelled": (ctx: LifecycleTurnContext) => Promise<void>;
}

function turnContext(turn: TurnRecord): LifecycleTurnContext {
  return { session: { auth: turn.auth, id: turn.sessionId, turn: { id: turn.id, sequence: turn.sequence } } };
}

export function lifecycleTurnObserver(events: LifecycleTurnEvents): TurnObserver {
  return {
    async turnStarted(turn) {
      await events["turn.started"](turnContext(turn));
    },
    async stepText() {},
    async toolsStarted() {},
    async inputRequested(event) {
      throw new AppError("AGENT_BACKGROUND_INPUT_UNAVAILABLE", "Фоновая задача не может ждать ответа человека", {
        details: { channelKind: event.turn.channel.kind, turnId: event.turn.id },
      });
    },
    async turnFinished({ outcome, turn }) {
      const ctx = turnContext(turn);
      if (outcome.status === "completed" || outcome.status === "waiting_input") await events["turn.completed"](ctx);
      else if (outcome.status === "failed") await events["turn.failed"]({ code: outcome.code, message: outcome.message }, ctx);
      else await events["turn.cancelled"](ctx);
    },
  };
}
