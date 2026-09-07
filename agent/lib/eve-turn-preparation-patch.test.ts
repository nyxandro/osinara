/** Required turn preparation is not a best-effort notification: failure must stop provider work. */
import { describe, expect, it, vi } from "vitest";
import { callAdapterEventHandler } from "../../node_modules/eve/dist/src/channel/adapter.js";

describe("Eve mandatory preparation", () => {
  it.each(["telegram", "memory-review"])("propagates the original preparation failure for %s", async (kind) => {
    const failure = new Error("AGENT_TEST_SOURCE_BINDING_FAILED");
    const provider = vi.fn();
    const execute = async () => {
      await callAdapterEventHandler({ kind, "turn.started": async () => { throw failure; } } as never,
        { type: "turn.started", data: { turnId: "turn_0" } } as never, {} as never);
      await provider();
    };
    await expect(execute()).rejects.toBe(failure);
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not change best-effort behavior of optional progress events", async () => {
    await expect(callAdapterEventHandler({ kind: "telegram", "message.appended": async () => {
      throw new Error("progress failed");
    } } as never, { type: "message.appended", data: {} } as never, {} as never)).resolves.toBeDefined();
  });

  it("stamps the current verified ingress identity on the returned session boundary", async () => {
    const result = await callAdapterEventHandler({ kind: "telegram" } as never,
      { type: "session.waiting", data: {} } as never,
      { session: { id: "session", auth: { current: { attributes: { osinaraTelegramIngressId: "new-send" } } } } } as never);
    expect(result).toMatchObject({ type: "session.waiting", data: { osinaraTelegramIngressId: "new-send" } });
  });
});
