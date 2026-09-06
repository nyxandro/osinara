/**
 * Model-safe long-term memory projection tests.
 *
 * Constructs covered:
 * - `toModelMemory`: exposes only the explicit model contract and an opaque stable reference.
 * - Internal database, identity, source, thread, and indexing fields never cross the model boundary.
 */
import { describe, expect, it } from "vitest";

import { toModelMemory } from "./model-memory.js";

describe("toModelMemory", () => {
  it("returns the exact model-safe DTO without internal identifiers or processing metadata", () => {
    const projected = toModelMemory({
      author: {
        status: "current_member",
        telegramUserId: "7100000001",
        userId: "00000000-0000-4000-8000-000000000002",
      },
      confirmation: "user_confirmed",
      content: "Пользователь предпочитает короткие ответы",
      createdAt: "2026-08-01T10:00:00.000Z",
      embeddingStatus: "indexed",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "preference",
      memoryRef: "mem_0123456789abcdef0123456789abcdef",
      occurredAt: null,
      messageThreadId: "42",
      scope: "personal",
      sensitivity: "normal",
      source: "eve:session-internal:turn-internal",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });

    expect(projected).toEqual({
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: "Пользователь предпочитает короткие ответы",
      createdAt: "2026-08-01T10:00:00.000Z",
      kind: "preference",
      memoryRef: "mem_0123456789abcdef0123456789abcdef",
      occurredAt: null,
      scope: "personal",
      sensitivity: "normal",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /00000000-0000-4000-8000-00000000000[12]|7100000001|messageThreadId|embeddingStatus|session-internal|turn-internal/u,
    );
  });
});
