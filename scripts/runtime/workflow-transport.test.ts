/** Transport reconnection cannot start a second live execution of the same durable delivery. */
import { describe, expect, it, vi } from "vitest";
import { createWorkflowExecutionFence, WORKFLOW_HTTP_TIMEOUT_MS } from "./workflow-transport.js";

const meta = (messageId: string) => ({ messageId, queueName: "__wkf_workflow_test", attempt: 1 }) as never;

describe("workflow execution fence", () => {
  it("shares live redelivery after a client disconnect, but permits a later durable reschedule", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => { await pending; return { timeoutSeconds: 1 }; });
    const handler = createWorkflowExecutionFence()(execute);
    const first = handler({ runId: "run" }, meta("message"));
    const second = handler({ runId: "run" }, { ...meta("message") as object, attempt: 2 } as never);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toEqual({ timeoutSeconds: 1 });
    await expect(second).resolves.toEqual({ timeoutSeconds: 1 });
    await handler({ runId: "run" }, meta("message"));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("admits control replays while an inline step is running, without duplicating a delivery", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const seen: string[] = [];
    const handler = createWorkflowExecutionFence()(async (_payload, delivery) => {
      seen.push(delivery.messageId);
      if (delivery.messageId === "first") await pending;
    });
    const first = handler({ runId: "run" }, meta("first"));
    const next = handler({ runId: "run", requestedAt: new Date() }, meta("next"));
    const replay = handler({ runId: "run" }, meta("first"));
    await handler({ runId: "run", stepId: "step" }, meta("step"));
    await handler({ runId: "other" }, meta("other"));
    expect(seen).toEqual(["first", "next", "step", "other"]);
    finish(); await Promise.all([first, next, replay]);
    expect(seen).toEqual(["first", "next", "step", "other"]);
  });

  it("rejects reuse of a live message ID with different bytes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const handler = createWorkflowExecutionFence()(async () => pending);
    const first = handler({ runId: "run" }, meta("message"));
    await expect(handler({ runId: "foreign" }, meta("message"))).rejects.toThrow("AGENT_WORKFLOW_DELIVERY_CONFLICT");
    finish(); await first;
  });

  it("preserves handler failure for all waiters and releases the next distinct delivery", async () => {
    const failure = new Error("execution failed");
    const execute = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const handler = createWorkflowExecutionFence()(execute);
    const first = handler({ runId: "run" }, meta("first"));
    const replay = handler({ runId: "run" }, meta("first"));
    const next = handler({ runId: "run" }, meta("next"));
    await expect(first).rejects.toBe(failure);
    await expect(replay).rejects.toBe(failure);
    await next;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(WORKFLOW_HTTP_TIMEOUT_MS).toBeGreaterThan(30 * 60 * 1000);
  });

  it("does not start a queued delivery once shutdown begins", async () => {
    let closing = false, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => gate);
    const handler = createWorkflowExecutionFence(() => closing)(execute);
    const first = handler({ runId: "run", stepId: "step" }, meta("first"));
    const next = handler({ runId: "run", stepId: "step" }, meta("next"));
    await Promise.resolve(); closing = true; finish();
    await first;
    await expect(next).rejects.toThrow("AGENT_WORKFLOW_SHUTTING_DOWN");
    expect(execute).toHaveBeenCalledOnce();
  });
});
