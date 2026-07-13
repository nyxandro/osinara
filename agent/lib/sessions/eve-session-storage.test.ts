/**
 * Eve local workflow retention adapter tests.
 *
 * Constructs covered:
 * - `deleteLocalEveSession`: removes one complete run graph without touching another run.
 * - Fail-fast behavior for unknown or incomplete storage layouts.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deleteLocalEveSession } from "./eve-session-storage.js";

const temporaryRoots: string[] = [];

async function put(root: string, path: string, content: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deleteLocalEveSession", () => {
  it("removes the selected run, stream chunks, and every hook index", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-"));
    temporaryRoots.push(root);
    const runId = "wrun_01KXB392VJ8YY13JMJ9YZAF5QR";
    const otherRunId = "wrun_01KXB3WRDW8D6K9YV82NFNSNKS";
    const hookId = "hook_01KXB392VJ7WV8K04QC5Z340YP";
    const streamId = "strm_01KXB392VJ8YY13JMJ9YZAF5QR_user";

    await put(root, `runs/${runId}.json`, { id: runId });
    await put(root, `runs/${otherRunId}.json`, { id: otherRunId });
    await put(root, `steps/${runId}-step_1.json`, { runId });
    await put(root, `events/${runId}-event_1.json`, { runId });
    await put(root, `streams/runs/${runId}.json`, { streams: [streamId] });
    await put(root, `streams/chunks/${streamId}/0001.json`, { text: "secret" });
    await put(root, `hooks/by-run/${runId}-${hookId}.json`, { hookId });
    await put(root, `hooks/${hookId}.json`, { hookId, runId });
    await put(root, `hooks/id-index/${hookId}/event.json`, { hookId });
    await put(root, "hooks/token-index/token/event.json", { hookId });
    await put(root, "hooks/tokens/token.json", { runId });

    await expect(deleteLocalEveSession(root, runId)).resolves.toMatchObject({
      hookCount: 1,
      streamCount: 1,
    });
    await expect(readFile(join(root, `runs/${otherRunId}.json`), "utf8")).resolves.toContain(otherRunId);
    await expect(readdir(join(root, "steps"))).resolves.toEqual([]);
    await expect(readdir(join(root, "events"))).resolves.toEqual([]);
    await expect(readdir(join(root, "streams/chunks"))).resolves.toEqual([]);
  });

  it("rejects a missing run instead of marking retention complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "runs"), { recursive: true });

    await expect(deleteLocalEveSession(root, "wrun_01KXB4EA5APPDAASE4GKT76XQS"))
      .rejects.toThrowError(/AGENT_EVE_SESSION_STORAGE_MISSING/);
  });
});
