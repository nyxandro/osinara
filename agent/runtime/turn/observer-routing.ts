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
    turnStarted: async (turn) => await observerOf(turn).turnStarted(turn),
    stepText: async (event) => await observerOf(event.turn).stepText(event),
    toolsStarted: async (event) => await observerOf(event.turn).toolsStarted(event),
    inputRequested: async (event) => await observerOf(event.turn).inputRequested(event),
    turnFinished: async (event) => await observerOf(event.turn).turnFinished(event),
  };
}
