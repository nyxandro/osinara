/**
 * Telegram final-delivery persisted intent tests.
 *
 * Constructs covered:
 * - A replay whose stored output or part count differs is refused before any provider send, whether
 *   the stored delivery is unsent or delivered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, release } = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));

vi.mock("./database.js", () => ({
  database: () => ({
    connect: async () => ({ query, release }),
    query,
  }),
}));

import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";

describe("Telegram final-delivery intent", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["an unsent intent with another output", "pending", "a".repeat(64), 2],
    ["an unsent intent with another part count", "pending", "b".repeat(64), 1],
    ["a delivered answer with another output", "delivered", "a".repeat(64), 2],
  ])("refuses %s instead of adopting it", async (_case, status, outputHash, chunkCount) => {
    query.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT id, output_hash")) {
        return {
          rows: [{ diagnostic_code: null, expected_chunk_count: 2, id: "delivery-1", output_hash: "b".repeat(64), status }],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(telegramFinalDeliveryRepository.start({
      applicationSessionId: "00000000-0000-4000-8000-000000000001",
      chunkCount,
      agentSessionId: "session-1",
      agentTurnId: "turn-1",
      outputHash,
    })).rejects.toThrowError(/AGENT_TELEGRAM_FINAL_DELIVERY_REPLAY_MISMATCH/u);
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/SET (?:output_hash|status)/u), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("telegram_final_delivery_chunks"), expect.anything());
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
