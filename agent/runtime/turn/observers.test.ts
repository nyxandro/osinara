import { describe, expect, it, vi } from "vitest";

import { lifecycleTurnObserver } from "./lifecycle-observer.js";
import { routeTurnObservers } from "./observer-routing.js";
import type { TurnObserver } from "./run-turn.js";
import type { TurnRecord } from "./turn-types.js";

const turn = (kind: string) => ({
  auth: { current: null, initiator: null }, channel: { kind }, id: "turn_1", sequence: 3, sessionId: "wrun_1",
}) as unknown as TurnRecord;

function recording(): TurnObserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async inputRequested() { calls.push("inputRequested"); },
    async stepText() { calls.push("stepText"); },
    async toolsStarted() { calls.push("toolsStarted"); },
    async turnFinished() { calls.push("turnFinished"); },
    async turnStarted() { calls.push("turnStarted"); },
  };
}

describe("turn observers", () => {
  it("routes each turn's events to the observer of its channel, and fails a turn of an unknown one", async () => {
    const telegram = recording();
    const review = recording();
    const routed = routeTurnObservers({ "memory-review": review, telegram });

    await routed.turnStarted(turn("telegram"));
    await routed.stepText({ finishReason: "stop", message: "hi", stepIndex: 0, turn: turn("memory-review") });

    expect(telegram.calls).toEqual(["turnStarted"]);
    expect(review.calls).toEqual(["stepText"]);
    await expect(routed.turnStarted(turn("subagent"))).rejects.toMatchObject({ code: "AGENT_TURN_CHANNEL_UNKNOWN" });
  });

  it("tells a delivery-less channel how its turn ended, and refuses a request for a person", async () => {
    const events = {
      "turn.cancelled": vi.fn(async () => {}),
      "turn.completed": vi.fn(async () => {}),
      "turn.failed": vi.fn(async () => {}),
      "turn.started": vi.fn(async () => {}),
    };
    const observer = lifecycleTurnObserver(events);
    const review = turn("memory-review");

    await observer.turnStarted(review);
    await observer.stepText({ finishReason: "stop", message: "не доставляется", stepIndex: 0, turn: review });
    await observer.turnFinished({ outcome: { status: "completed", text: "итог" }, turn: review });
    await observer.turnFinished({ outcome: { code: "AGENT_X", message: "сбой", status: "failed" }, turn: review });
    await observer.turnFinished({ outcome: { status: "cancelled" }, turn: review });

    const ctx = { session: { auth: review.auth, id: "wrun_1", turn: { id: "turn_1", sequence: 3 } } };
    expect(events["turn.started"]).toHaveBeenCalledWith(ctx);
    expect(events["turn.completed"]).toHaveBeenCalledWith(ctx);
    expect(events["turn.failed"]).toHaveBeenCalledWith({ code: "AGENT_X", message: "сбой" }, ctx);
    expect(events["turn.cancelled"]).toHaveBeenCalledWith(ctx);
    await expect(observer.inputRequested({ requests: [], stepIndex: 0, turn: review }))
      .rejects.toMatchObject({ code: "AGENT_BACKGROUND_INPUT_UNAVAILABLE" });
  });
});
