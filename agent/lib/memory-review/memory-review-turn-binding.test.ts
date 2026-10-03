/** A resumed old turn must settle its own review, not the newer caller's marker. */
import { describe, expect, it, vi } from "vitest";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { resolveMemoryReviewBatch } from "./memory-review-turn-binding.js";

vi.mock("./memory-review-repository.js", () => ({
  memoryReviewRepository: { batchForTurn: vi.fn() },
}));

describe("resolveMemoryReviewBatch", () => {
  it("uses the persisted turn binding before a marker inherited from a later reply", async () => {
    vi.mocked(memoryReviewRepository.batchForTurn).mockResolvedValue({ batchId: "old-batch", eveTurnId: "old-turn" });
    await expect(resolveMemoryReviewBatch({
      session: {
        id: "session",
        turn: { id: "old-turn" },
        auth: {
          current: {
            authenticator: "telegram",
            principalType: "user",
            principalId: "user",
            attributes: { memoryReviewBatchId: "new-batch" },
          },
          initiator: null,
        },
      },
    })).resolves.toEqual({ batchId: "old-batch", eveTurnId: "old-turn" });
  });

  it("retains the marker for an identical terminal replay after the batch was released", async () => {
    vi.mocked(memoryReviewRepository.batchForTurn).mockResolvedValue(null);
    await expect(resolveMemoryReviewBatch({
      session: {
        id: "session",
        turn: { id: "old-turn" },
        auth: {
          current: {
            authenticator: "telegram",
            principalType: "user",
            principalId: "user",
            attributes: { memoryReviewBatchId: "released-batch" },
          },
          initiator: null,
        },
      },
    })).resolves.toEqual({ batchId: "released-batch", eveTurnId: "old-turn" });
  });
});
