/**
 * Memory embedding chunker tests.
 *
 * Constructs covered:
 * - `chunkMemoryContent`: deterministic overlapping coverage within the E5 input budget.
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
} from "./memory-config.js";
import { chunkMemoryContent } from "./memory-embedding-chunks.js";

describe("chunkMemoryContent", () => {
  it("keeps short content in one source-aligned chunk", () => {
    expect(chunkMemoryContent("  Семья любит поездки в Казань.  ")).toEqual([
      {
        chunkIndex: 0,
        content: "Семья любит поездки в Казань.",
        endOffset: 31,
        startOffset: 2,
      },
    ]);
  });

  it("covers long Russian content with bounded deterministic overlap", () => {
    const content = Array.from(
      { length: 80 },
      (_, index) => `Факт-${index} относится к семейной истории.`,
    ).join(" ");
    const chunks = chunkMemoryContent(content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.every((chunk) => chunk.content.length <= MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS)).toBe(true);
    expect(chunks.at(-1)?.endOffset).toBe(content.length);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      expect(previous.endOffset - current.startOffset).toBeGreaterThan(0);
      expect(previous.endOffset - current.startOffset).toBeLessThanOrEqual(
        MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
      );
    }
  });
});
