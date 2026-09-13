/**
 * Telegram final-delivery persisted intent compatibility tests.
 *
 * Constructs covered:
 * - A pending pre-v0.14 hash adopts the new presentation before any provider send.
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

describe("Telegram final-delivery intent compatibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upgrades an unsent legacy intent before claiming delivery", async () => {
    const legacyHash = "a".repeat(64);
    const outputHash = "b".repeat(64);
    query.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT id, output_hash")) {
        return {
          rows: [{
            diagnostic_code: null,
            expected_chunk_count: 1,
            id: "delivery-1",
            output_hash: legacyHash,
            status: "pending",
          }],
        };
      }
      if (statement.includes("SET status = 'started'")) {
        return { rows: [{ delivery_token: "token-1", id: "delivery-1" }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(telegramFinalDeliveryRepository.start({
      applicationSessionId: "00000000-0000-4000-8000-000000000001",
      chunkCount: 2,
      eveSessionId: "session-1",
      eveTurnId: "turn-1",
      legacyChunkCount: 1,
      legacyOutputHash: legacyHash,
      outputHash,
    })).resolves.toEqual({
      deliveryId: "delivery-1",
      deliveryToken: "token-1",
      status: "started",
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET output_hash = $2, expected_chunk_count = $3"),
      ["delivery-1", outputHash, 2],
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
