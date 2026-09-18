import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

describe("Postgres stream wakeups", () => {
  it("does not read payloads for notifications while an open reader has no demand", async () => {
    // Execute the installed artifact with only its PostgreSQL socket substituted. Node's external
    // package loader does not reliably honor Vitest's pg mock across the world's module boundary.
    const root = resolve("node_modules/@workflow/world-postgres/dist");
    let source = await readFile(resolve(root, "streamer.js"), "utf8");
    source = source.replace("import { Client } from 'pg';", `export const testClients=[];
      class Client extends EventEmitter {constructor(){super();testClients.push(this)} async connect(){} async query(){} async end(){}}`);
    source = source.replace(/from '([^']+)'/g, (match, specifier: string) => specifier.startsWith("node:") ? match
      : `from ${JSON.stringify(specifier.startsWith(".") ? pathToFileURL(resolve(root, specifier)).href : import.meta.resolve(specifier))}`);
    const { createStreamer, testClients: clients } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const select = vi.fn(() => { throw new Error("No payload query expected without demand"); });
    const streamer = createStreamer({ options: {} } as never, { select } as never);
    const stream = await streamer.streams.get("run", "strm_test", 0);
    try {
      const client = clients.at(-1)!;
      await vi.waitFor(() => expect(client.listenerCount("notification")).toBe(1));
      for (let i = 0; i < 500; i++) client.emit("notification", { payload: JSON.stringify({ streamId: "strm_test", chunkId: `chnk_${i}` }) });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(select).not.toHaveBeenCalled();
    } finally { await stream.cancel(); await streamer.close(); }
    expect(clients.at(-1)!.listenerCount("notification")).toBe(0);
    // Rewrites the installed streamer, imports it as a data URL and drives five hundred
    // notifications through it. That is real work, and the default five seconds is a budget for
    // an idle machine, not for one running the whole suite in parallel.
  }, 30_000);
});
