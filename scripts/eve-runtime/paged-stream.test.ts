import { describe, expect, it, vi } from "vitest";
import { createPagedStream } from "./paged-stream.ts";

function fixture() {
  let wake = () => {};
  const unsubscribe = vi.fn();
  const initialize = vi.fn(async (index: number) => ({ after: index === 0 ? null : `id-${index}`, skip: 0 }));
  const page = vi.fn(async (_after: string | null) => [
    { id: "id-2", data: new Uint8Array([2]), eof: false },
    { id: "id-3", data: new Uint8Array([3]), eof: false },
    { id: "id-4", data: new Uint8Array(), eof: true },
  ]);
  return { initialize, page, unsubscribe, notify: () => wake(), subscribe(fn: () => void) { wake = fn; return unsubscribe; } };
}

describe("bounded durable stream consumption", () => {
  it("supports native byte-stream consumers without transferring pg's pooled Buffer", async () => {
    const f = fixture();
    const payload = Buffer.from("cancel");
    f.page.mockResolvedValue([{ id: "abort", data: payload, eof: false }]);
    const source = createPagedStream(f).getReader();
    const native = new ReadableStream<Uint8Array>({ type: "bytes",
      async pull(controller) {
        const item = await source.read();
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      },
      cancel: () => source.cancel(),
    });
    const reader = native.getReader();
    try {
      await expect(reader.read()).resolves.toEqual({ value: new TextEncoder().encode("cancel"), done: false });
      expect(payload.toString()).toBe("cancel");
    } finally { await source.cancel(); source.releaseLock(); reader.releaseLock(); }
  });
  it("does not fetch before demand, reads from the requested cursor and unsubscribes at EOF", async () => {
    const f = fixture(); const stream = createPagedStream(f, 1);
    await Promise.resolve(); expect(f.page).not.toHaveBeenCalled();
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    expect(f.initialize).toHaveBeenCalledWith(1);
    expect(f.page).toHaveBeenCalledWith("id-1");
    expect((await reader.read()).value).toEqual(new Uint8Array([3]));
    expect((await reader.read()).done).toBe(true);
    expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it("waits for new durable data and recovers a missed notification by polling, not retrying errors", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.page.mockResolvedValueOnce([]);
    const reader = createPagedStream(f, 0).getReader();
    try {
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).value).toEqual(new Uint8Array([2]));
      expect(f.page).toHaveBeenCalledTimes(2);
    } finally { await reader.cancel(); reader.releaseLock(); vi.useRealTimers(); }
  });

  it("does not miss a notification arriving while the empty page is being fetched", async () => {
    const f = fixture(); f.page.mockImplementationOnce(async () => { f.notify(); return []; });
    const reader = createPagedStream(f, 0).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    expect(f.page).toHaveBeenCalledTimes(2);
    await reader.cancel(); reader.releaseLock(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight page without late enqueue, new queries, or leaked subscriptions", async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<typeof f.page>>) => void;
    f.page.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reader = createPagedStream(f, 0).getReader(); const pending = reader.read();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await reader.cancel(); release([{ id: "late", data: new Uint8Array([1]), eof: false }]);
    expect((await pending).done).toBe(true);
    await Promise.resolve(); expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it("propagates a database failure once and removes its listener", async () => {
    const f = fixture(); const error = new Error("database unavailable"); f.page.mockRejectedValue(error);
    const reader = createPagedStream(f, 0).getReader();
    await expect(reader.read()).rejects.toBe(error);
    expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce(); reader.releaseLock();
  });

  it("skips future data positions but still closes at EOF", async () => {
    const f = fixture(); f.initialize.mockResolvedValue({ after: "id-1", skip: 5 });
    const reader = createPagedStream(f, 6).getReader();
    expect((await reader.read()).done).toBe(true); expect(f.unsubscribe).toHaveBeenCalledOnce(); reader.releaseLock();
  });
});
