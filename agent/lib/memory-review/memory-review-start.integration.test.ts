/** The internal review turn: its own session per batch attempt, started in the background. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryReviewStart, MEMORY_REVIEW_CHANNEL_KIND } from "../../channels/memory-review.js";
import type { SessionAuthContext } from "../../runtime/context.js";
import { createApplicationSession } from "../../runtime/history/history.integration-fixtures.js";
import { newSessionId } from "../../runtime/ids.js";
import { findContinuation } from "../../runtime/session/continuations.js";
import { loadTurn } from "../../runtime/turn/journal-repository.js";
import { closeDatabase, database } from "../database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const BATCH = "00000000-0000-4000-8000-000000000050";

async function reviewAuth(generation: string): Promise<SessionAuthContext> {
  const { applicationSessionId } = await createApplicationSession(newSessionId());
  return {
    attributes: { applicationSessionId, memoryReviewBatchId: BATCH, memoryReviewGeneration: generation, memoryReviewMode: "background" },
    authenticator: "memory-review", principalId: "user-1", principalType: "user",
  };
}

(enabled ? describe : describe.skip)("memory review start", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("opens the review's own session per attempt and starts its turn in the background", async () => {
    const start = vi.fn();
    const startReview = createMemoryReviewStart({ database: database(), dispatcher: { start } });

    const first = await startReview(BATCH, "<batch/>", { auth: await reviewAuth("0") });
    const retry = await startReview(BATCH, "<batch/>", { auth: await reviewAuth("1") });

    expect(retry.sessionId).not.toBe(first.sessionId);
    expect(await findContinuation(database(), { channelKind: MEMORY_REVIEW_CHANNEL_KIND, token: `memory-review:${BATCH}` })).toBe(first.sessionId);
    expect(await findContinuation(database(), { channelKind: MEMORY_REVIEW_CHANNEL_KIND, token: `memory-review:${BATCH}:attempt:1` })).toBe(retry.sessionId);
    expect(start).toHaveBeenCalledTimes(2);
    expect(await loadTurn(database(), start.mock.calls[0]![0] as string)).toMatchObject({
      channel: { kind: MEMORY_REVIEW_CHANNEL_KIND }, input: { context: [], message: "<batch/>" }, kind: "memory_review",
    });
  });

  it("refuses a target the verified auth does not name", async () => {
    const startReview = createMemoryReviewStart({ database: database(), dispatcher: { start: vi.fn() } });

    await expect(startReview("00000000-0000-4000-8000-000000000051", "<batch/>", { auth: await reviewAuth("0") }))
      .rejects.toThrow("AGENT_MEMORY_REVIEW_HANDOFF_INVALID");
    await expect(startReview(BATCH, "<batch/>", { auth: await reviewAuth("x") })).rejects.toThrow("AGENT_MEMORY_REVIEW_GENERATION_INVALID");
  });
});
