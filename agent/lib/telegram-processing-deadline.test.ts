/** Admission is bounded, active model work is not; cancellation is confirmed before FIFO continues. */
import { describe, expect, it, vi } from "vitest";
import { runTelegramProcessing, requireTelegramAdmissionDeadline } from "./telegram-processing-deadline.js";
import { AppError } from "./app-error.js";

function session(settles = true) {
  let cancelled = false;
  let dispatchId: string;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  type Event = { type: string; data?: Record<string, unknown> };
  const streams: ReadableStreamDefaultController<Event>[] = [];
  return {
    id: "eve-deadline",
    stopped,
    correlate(value: string) { dispatchId = value; },
    cancel: vi.fn(async () => {
      cancelled = true;
      if (settles) {
        for (const stream of streams) stream.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: dispatchId } });
        finish();
      }
      return { status: "accepted", sessionId: "eve-deadline" } as const;
    }),
    getEventStream: vi.fn(async () => new ReadableStream<Event>({ start(c) {
      streams.push(c);
      c.enqueue({ type: "turn.started", data: { turnId: "turn_7", osinaraTelegramIngressId: dispatchId } });
      if (settles && cancelled) c.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: dispatchId } });
    } })),
  };
}

describe("Telegram processing deadline", () => {
  it("cancels an identified session even while native dispatch has not returned", async () => {
    const active = session();
    let signal!: AbortSignal;
    await expect(runTelegramProcessing({ timeoutMilliseconds: 15, cancellationMilliseconds: 100,
      readCursor: async () => 7,
      async execute(control) {
        signal = control.signal;
        active.correlate(control.dispatchId);
        control.onDispatch({ resolveSession: async () => active });
        await active.stopped;
        control.observeSession(active);
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_TIMEOUT", eveSessionId: active.id });
    expect(signal.aborted).toBe(true);
    expect(active.cancel).toHaveBeenCalledTimes(1);
    expect(active.cancel).toHaveBeenCalledWith({ turnId: "turn_7" });
    expect(active.getEventStream).toHaveBeenCalledWith({ startIndex: 7 });
  });

  it("quarantines rather than claiming cancellation when the boundary never arrives", async () => {
    const active = session(false);
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 15,
      readCursor: async () => 0,
      async execute(control) {
        active.correlate(control.dispatchId);
        control.onDispatch({ resolveSession: async () => active });
        return await new Promise(() => {});
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", eveSessionId: active.id });
  });

  it("does not report cancellation success when the session cannot be resolved", async () => {
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 15,
      readCursor: async () => 0,
      async execute(control) {
        control.onDispatch({ resolveSession: async () => undefined });
        return await new Promise(() => {});
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
  });

  it("fences a timed-out preparation before it can start dispatch", async () => {
    let proceed!: () => void;
    const late = new Promise<void>((resolve) => { proceed = resolve; });
    const start = vi.fn();
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 20,
      readCursor: async () => 0,
      async execute(control) { await late; control.signal.throwIfAborted(); start(); },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    proceed();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves ordinary success and original errors", async () => {
    const options = { timeoutMilliseconds: 100, cancellationMilliseconds: 20, readCursor: async () => 0 };
    await expect(runTelegramProcessing({ ...options, execute: async () => "ok" })).resolves.toBe("ok");
    const failure = new Error("preparation failed");
    await expect(runTelegramProcessing({ ...options, execute: async () => { throw failure; } })).rejects.toBe(failure);
  });

  it("does not apply the admission deadline to an already accepted model turn", async () => {
    const active = session(false);
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 20,
      readCursor: async () => 0,
      async execute(control) {
        control.observeSession(active);
        await new Promise((resolve) => setTimeout(resolve, 35));
        return "finished after admission window";
      },
    })).resolves.toBe("finished after admission window");
    expect(active.cancel).not.toHaveBeenCalled();
  });

  it("accepts a question continuation that resolves the old turn before starting its next turn", async () => {
    const active = session();
    await expect(runTelegramProcessing({ timeoutMilliseconds: 100, cancellationMilliseconds: 20,
      readCursor: async () => 0,
      async execute(control) {
        active.correlate(control.dispatchId);
        control.observeSession(active);
        control.acceptsEvent({ type: "input.resolved", data: { turnId: "turn_6", osinaraTelegramIngressId: control.dispatchId } });
        control.acceptsEvent({ type: "turn.started", data: { turnId: "turn_7", osinaraTelegramIngressId: control.dispatchId } });
        return "continued";
      },
    })).resolves.toBe("continued");
    expect(active.cancel).not.toHaveBeenCalled();
  });

  it("does not free the queue while an application callback or dispatch is still running", async () => {
    const active = session();
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 20,
      readCursor: async () => 7,
      async execute(control) {
        active.correlate(control.dispatchId);
        control.onDispatch({ resolveSession: async () => active });
        return await new Promise(() => {});
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
  });

  it("confirms a cooperative abort before any model dispatch", async () => {
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 20,
      readCursor: async () => 0,
      async execute(control) {
        await new Promise((_resolve, reject) => control.signal.addEventListener("abort", () => reject(control.signal.reason), { once: true }));
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_TIMEOUT" });
  });

  it("never treats an uncorrelated waiting event as proof of cancellation", async () => {
    const active = { id: "old-boundary", cancel: vi.fn(), getEventStream: async () => new ReadableStream({
      start(c) { c.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: "older-dispatch" } }); },
    }) };
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 20,
      readCursor: async () => 0, async execute(control) {
        control.observeSession(active);
        throw new AppError("AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT", "Observer lost");
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    expect(active.cancel).not.toHaveBeenCalled();
  });

  it("quarantines a dispatched session when its event stream fails before the deadline", async () => {
    const failure = new Error("stream transport lost");
    const active = { id: "lost-stream", cancel: vi.fn(), getEventStream: async () => { throw failure; } };
    await expect(runTelegramProcessing({ timeoutMilliseconds: 100, cancellationMilliseconds: 20,
      readCursor: async () => 0, async execute(control) { control.observeSession(active); throw failure; },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", cause: failure });
  });

  it("requests cancellation of an already observed turn even if the stream cannot reopen", async () => {
    const failure = new Error("stream transport lost");
    const active = { id: "observed-turn", cancel: vi.fn().mockResolvedValue({ status: "accepted", sessionId: "observed-turn" }),
      getEventStream: async () => { throw failure; } };
    await expect(runTelegramProcessing({ timeoutMilliseconds: 100, cancellationMilliseconds: 20,
      readCursor: async () => 0, async execute(control) {
        control.observeSession(active);
        control.acceptsEvent({ type: "turn.started", data: { turnId: "turn_9", osinaraTelegramIngressId: control.dispatchId } });
        throw failure;
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    expect(active.cancel).toHaveBeenCalledWith({ turnId: "turn_9" });
  });

  it("cancels admitted work on lost ownership rather than waiting for a model timeout", async () => {
    const ownership = new AbortController();
    const active = session();
    await expect(runTelegramProcessing({ timeoutMilliseconds: 1000, cancellationMilliseconds: 100,
      signal: ownership.signal, readCursor: async () => 0,
      async execute(control) {
        active.correlate(control.dispatchId);
        control.observeSession(active);
        control.acceptsEvent({ type: "turn.started", data: { turnId: "turn_7", osinaraTelegramIngressId: control.dispatchId } });
        ownership.abort(new Error("Lease lost"));
        await active.stopped;
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_INTERRUPTED" });
    expect(active.cancel).toHaveBeenCalledWith({ turnId: "turn_7" });
  });

  it.each([true, false])("cancels a new question-response turn during cancellation (observer ahead: %s)", async (observerAhead) => {
    const ownership = new AbortController();
    let started!: () => void, stopped!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const stop = new Promise<void>((resolve) => { stopped = resolve; });
    let dispatchId: string;
    let reader!: ReadableStreamDefaultController<{ type: string; data: Record<string, unknown> }>;
    const active = {
      id: "question-session",
      cancel: vi.fn(async ({ turnId }: { turnId: string }) => {
        if (turnId === "turn_6") started();
        else { reader.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: dispatchId } }); stopped(); }
        return { status: "accepted", sessionId: "question-session" } as const;
      }),
      getEventStream: async () => new ReadableStream({ start(c) {
        reader = c;
        c.enqueue({ type: "turn.started", data: { turnId: "turn_7", osinaraTelegramIngressId: dispatchId } });
      } }),
    };
    await expect(runTelegramProcessing({ timeoutMilliseconds: 1000, cancellationMilliseconds: 40,
      signal: ownership.signal, readCursor: async () => 0,
      async execute(control) {
        dispatchId = control.dispatchId;
        control.observeSession(active);
        control.acceptsEvent({ type: "input.resolved", data: { turnId: "turn_6", osinaraTelegramIngressId: dispatchId } });
        ownership.abort(new Error("Lease lost during question response"));
        await start;
        if (observerAhead) control.acceptsEvent({ type: "turn.started", data: { turnId: "turn_7", osinaraTelegramIngressId: dispatchId } });
        await stop;
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_INTERRUPTED" });
    expect(active.cancel.mock.calls.map(([options]) => options.turnId)).toEqual(["turn_6", "turn_7"]);
  });

  it("does not let a late continuation lookup replace the session returned by dispatch", async () => {
    const actual = session(false);
    const previous = { id: "previous-session", cancel: vi.fn(), getEventStream: async () => new ReadableStream({
      start(c) { c.enqueue({ type: "session.completed" }); },
    }) };
    let complete!: () => void;
    const dispatched = new Promise<void>((resolve) => { complete = resolve; });
    await expect(runTelegramProcessing({ timeoutMilliseconds: 10, cancellationMilliseconds: 30,
      readCursor: async () => 0,
      async execute(control) {
        control.onDispatch({ async resolveSession() {
          control.observeSession(actual);
          complete();
          return previous;
        } });
        await dispatched;
      },
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", eveSessionId: actual.id });
    expect(previous.cancel).not.toHaveBeenCalled();
  });

  it("rejects expired and malformed durable deadlines before model preparation", () => {
    const auth = (value: string) => ({ current: { attributes: { osinaraTelegramDeadlineAt: value } } }) as never;
    expect(() => requireTelegramAdmissionDeadline(auth("2020-01-01T00:00:00.000Z"))).toThrow("AGENT_TELEGRAM_PROCESSING_TIMEOUT");
    expect(() => requireTelegramAdmissionDeadline(auth("bad"))).toThrow("AGENT_TELEGRAM_DEADLINE_INVALID");
    expect(() => requireTelegramAdmissionDeadline(auth(new Date(Date.now() + 1000).toISOString()))).not.toThrow();
  });
});
