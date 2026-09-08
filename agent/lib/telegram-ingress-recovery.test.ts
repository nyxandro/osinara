/** Reattach after process loss without submitting a second model request. */
import { describe, expect, it, vi } from "vitest";
import { recoverTelegramIngress } from "./telegram-ingress-recovery.js";

const dispatch = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  sessionId: "session-1",
  turnId: "turn_4",
  cursor: 12,
};

function session(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  return {
    id: dispatch.sessionId,
    send: vi.fn(),
    cancel: vi.fn(),
    getEventStream: vi.fn(async () => new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      },
    })),
  };
}

describe("Telegram ingress recovery", () => {
  it("ignores another delivery boundary and resumes the saved cursor without resending", async () => {
    const current = session([
      { type: "session.waiting", data: { osinaraTelegramIngressId: "earlier" } },
      { type: "message.completed", data: { osinaraTelegramIngressId: dispatch.id } },
      { type: "session.waiting", data: { osinaraTelegramIngressId: dispatch.id } },
    ]);
    const attach = vi.fn(() => current);
    await expect(recoverTelegramIngress({ dispatch, attach, timeoutMs: 100, cancellationMs: 20 }))
      .resolves.toEqual({ sessionId: current.id, nextEventIndex: 15 });
    expect(attach).toHaveBeenCalledWith(current.id);
    expect(current.getEventStream).toHaveBeenCalledWith({ startIndex: 12 });
    expect(current.send).not.toHaveBeenCalled();
    expect(current.cancel).not.toHaveBeenCalled();
  });

  it("does not infer a safe restart from an unbound dispatch", async () => {
    const attach = vi.fn();
    await expect(recoverTelegramIngress({ dispatch: null, attach, timeoutMs: 100, cancellationMs: 20 }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("accepts a terminal exact-session boundary after restart", async () => {
    const current = session([{ type: "session.completed" }]);
    await expect(recoverTelegramIngress({ dispatch, attach: () => current, timeoutMs: 100, cancellationMs: 20 }))
      .resolves.toEqual({ sessionId: current.id, nextEventIndex: 13 });
  });

  it("keeps quarantine when stream loss cannot be followed by confirmed cancellation", async () => {
    const current = session([]);
    current.cancel.mockResolvedValue({ status: "accepted", sessionId: current.id });
    await expect(recoverTelegramIngress({ dispatch, attach: () => current, timeoutMs: 30, cancellationMs: 20 }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    expect(current.send).not.toHaveBeenCalled();
  });

  it("reports a confirmed interrupted turn without replaying it", async () => {
    const current = session([
      { type: "turn.cancelled", data: { osinaraTelegramIngressId: dispatch.id } },
      { type: "session.waiting", data: { osinaraTelegramIngressId: dispatch.id } },
    ]);
    await expect(recoverTelegramIngress({ dispatch, attach: () => current, timeoutMs: 100, cancellationMs: 20 }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_INTERRUPTED", eveSessionId: current.id });
    expect(current.send).not.toHaveBeenCalled();
  });

  it("an operator cancel still requires an observed boundary, not just accepted", async () => {
    const current = session([]);
    current.cancel.mockResolvedValue({ status: "accepted", sessionId: current.id });
    await expect(recoverTelegramIngress({ dispatch, cancel: true, attach: () => current, timeoutMs: 30, cancellationMs: 20 }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    expect(current.cancel).toHaveBeenCalledWith({ turnId: dispatch.turnId });
  });

  it("bounds a stuck cancellation request", async () => {
    const current = session([]);
    current.cancel.mockImplementation(() => new Promise(() => {}));
    await expect(recoverTelegramIngress({ dispatch, cancel: true, attach: () => current, timeoutMs: 30, cancellationMs: 20 }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
  });
  it("follows an execution which is still producing output after the observer restarts", async () => {
    let writer!: ReadableStreamDefaultController<{ type: string; data: Record<string, unknown> }>;
    const current = session([]);
    current.getEventStream.mockImplementation(async () => new ReadableStream({ start(c) { writer = c; } }));
    let settled = false;
    const recovering = recoverTelegramIngress({ dispatch, attach: () => current, timeoutMs: 1000, cancellationMs: 20 })
      .then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(writer).toBeDefined());
    writer.enqueue({ type: "message.appended", data: { osinaraTelegramIngressId: dispatch.id } });
    expect(settled).toBe(false);
    writer.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: dispatch.id } });
    await expect(recovering).resolves.toEqual({ sessionId: current.id, nextEventIndex: 14 });
    expect(current.send).not.toHaveBeenCalled();
  });
});
