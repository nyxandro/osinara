/**
 * One observer for the runtime, routing each turn's events to the observer of its channel.
 *
 * Export:
 * - `routeTurnObservers`: by `turn.channel.kind`; a turn of a channel nobody observes fails, so its
 *   answer is never computed without a way to deliver it.
 */
import { AppError } from "../../lib/app-error.js";
import type { TurnObserver } from "./run-turn.js";
import type { TurnRecord } from "./turn-types.js";

export function routeTurnObservers(observers: Readonly<Record<string, TurnObserver>>): TurnObserver {
  function observerOf(turn: TurnRecord): TurnObserver {
    const observer = observers[turn.channel.kind];
    if (observer === undefined) {
      throw new AppError("AGENT_TURN_CHANNEL_UNKNOWN", "Не удалось определить канал доставки ответа", {
        details: { channelKind: turn.channel.kind, turnId: turn.id },
      });
    }
    return observer;
  }
  return {
    turnStarted: (turn) => observerOf(turn).turnStarted(turn),
    stepText: (event) => observerOf(event.turn).stepText(event),
    toolsStarted: (event) => observerOf(event.turn).toolsStarted(event),
    inputRequested: (event) => observerOf(event.turn).inputRequested(event),
    turnFinished: (event) => observerOf(event.turn).turnFinished(event),
  };
}
