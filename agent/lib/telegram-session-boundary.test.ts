/** Stream failures and late cleanup must remain bounded and observable at the ingress boundary. */
import { describe, expect, it, vi } from "vitest";
import { waitForSessionBoundary } from "./telegram-session-boundary.js";

describe("waitForSessionBoundary", () => {
  it("bounds cleanup after a child-owning parent is cancelled without subagent.completed", async () => {
    vi.useFakeTimers();
    let close!: () => void;
    let result: number | undefined;
    const pending = waitForSessionBoundary({ id: "cancelled-parent", getEventStream: async () => new ReadableStream({
      start(c) {
        c.enqueue({ type: "subagent.called", data: { callId: "child" } });
        c.enqueue({ type: "turn.cancelled" });
        c.enqueue({ type: "session.waiting" });
      },
      cancel: () => new Promise<void>((resolve) => { close = resolve; }),
    }) }, 0, 30, { idle: true }).then((cursor) => { result = cursor; });
    try {
      await vi.advanceTimersByTimeAsync(120);
      expect(result).toBe(3);
    } finally { close(); await pending; vi.useRealTimers(); }
  });
  it("does not mistake waiting for a native child for a silent parent model", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<{ type: string; data?: Record<string, unknown> }>;
    const pending = waitForSessionBoundary({ id: "parent", getEventStream: async () => new ReadableStream({ start(c) { controller = c; } }) },
      0, 30, { idle: true }).then((value) => value, (error) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.enqueue({ type: "subagent.called", data: { callId: "child-call" } });
      await vi.advanceTimersByTimeAsync(1000);
      controller.enqueue({ type: "subagent.completed", data: { callId: "child-call" } });
      controller.enqueue({ type: "session.waiting" });
      expect(await pending).toBe(3);
    } finally { vi.useRealTimers(); }
  });
  it("extends only the observer's idle window while the current turn keeps producing events", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<{ type: string }>;
    const pending = waitForSessionBoundary({ id: "active", getEventStream: async () => new ReadableStream({ start(c) { controller = c; } }) },
      0, 30, { idle: true }).then((value) => value, (error) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10; index++) {
        controller.enqueue({ type: "reasoning.appended" });
        await vi.advanceTimersByTimeAsync(25);
      }
      controller.enqueue({ type: "session.waiting" });
      expect(await pending).toBe(11);
    } finally { vi.useRealTimers(); }
  });
  it("preserves a failure to open the stream", async () => {
    const error = new Error("stream storage unavailable");
    await expect(waitForSessionBoundary({
      id: "session", getEventStream: async () => { throw error; },
    }, 0, 100)).rejects.toBe(error);
  });

  it("rejects a closed stream without a boundary", async () => {
    await expect(waitForSessionBoundary({
      id: "session",
      getEventStream: async () => new ReadableStream({ start(c) { c.close(); } }),
    }, 0, 100)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING" });
  });

  it("preserves the completed cursor despite cancellation failure", async () => {
    const error = new Error("stream cancellation failed");
    const stream = new ReadableStream({
      start(c) { c.enqueue({ type: "session.waiting" }); },
      cancel() { throw error; },
    });
    await expect(waitForSessionBoundary({ id: "session", getEventStream: async () => stream }, 0, 100)).resolves.toBe(1);
    expect(stream.locked).toBe(false);
  });

  it("settles a timeout even when cancelling the silent stream rejects", async () => {
    const cancel = vi.fn(() => { throw new Error("cancel failed after timeout"); });
    const stream = new ReadableStream<{ type: string }>({ cancel });
    await expect(waitForSessionBoundary({ id: "session", getEventStream: async () => stream }, 0, 10))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT" });
    await vi.waitFor(() => expect(stream.locked).toBe(false));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a boundary for either of the next two turns after stuck cleanup", async () => {
    const history = [{ type: "turn.started" }, { type: "session.waiting" }];
    let controller!: ReadableStreamDefaultController<{ type: string }>;
    let releaseCancel!: () => void;
    let opens = 0;
    const session = {
      id: "reused-session",
      async getEventStream(options?: { startIndex?: number }) {
        opens += 1;
        const first = opens === 1;
        return new ReadableStream({
          start(c) {
            controller = c;
            for (const event of history.slice(options?.startIndex ?? 0)) c.enqueue(event);
          },
          cancel() { if (first) return new Promise<void>((resolve) => { releaseCancel = resolve; }); },
        });
      },
    };
    let cursor = await waitForSessionBoundary(session, 0, 10);
    releaseCancel();
    expect(cursor).toBe(2);
    for (const expectedCursor of [4, 6]) {
      history.push({ type: "turn.started" });
      const pending = waitForSessionBoundary(session, cursor, 200);
      const settledEarly = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 15)),
      ]);
      expect(settledEarly).toBe(false);
      const waiting = { type: "session.waiting" };
      history.push(waiting);
      controller.enqueue(waiting);
      cursor = await pending;
      expect(cursor).toBe(expectedCursor);
    }
  });
});
