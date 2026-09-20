/**
 * Fitting chunks into the model's window.
 *
 * Constructs covered:
 * - Chunks that already fit are returned untouched and measured only once.
 * - A chunk the tokenizer calls too long is split at a whitespace boundary inside its own offsets.
 * - The pieces never overlap, cover the original end to end, and each stays an exact slice.
 * - Text that cannot be divided far enough fails loudly instead of being sent and rejected.
 */
import { describe, expect, it, vi } from "vitest";

import { fitMemoryChunksToTokenLimit } from "./memory-embedding-fitting.js";
import { MEMORY_EMBEDDING_MAX_TOKENS } from "./memory-config.js";

interface TestChunk {
  chunkIndex: number;
  content: string;
  endOffset: number;
  startOffset: number;
}

function wholeText(content: string): TestChunk[] {
  return [{ chunkIndex: 0, content, endOffset: content.length, startOffset: 0 }];
}

/** One token per character is the worst real case: a script with no multi-character tokens. */
function tokensPerCharacter(chunks: readonly TestChunk[]): Promise<number[]> {
  return Promise.resolve(chunks.map((chunk) => chunk.content.length));
}

describe("fitMemoryChunksToTokenLimit", () => {
  it("returns chunks that already fit and asks the tokenizer once", async () => {
    const content = "Короткая запись про кота Тихона.";
    const measure = vi.fn(tokensPerCharacter);

    const fitted = await fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure,
    });

    expect(fitted.map((chunk) => chunk.content)).toEqual([content]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("splits an oversize chunk until every piece fits", async () => {
    const content = Array.from({ length: 400 }, (_, index) => `слово${index}`).join(" ");
    const splits: number[] = [];

    const fitted = await fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure: tokensPerCharacter,
      onSplit: (tokens) => splits.push(tokens),
    });

    expect(fitted.length).toBeGreaterThan(1);
    for (const chunk of fitted) {
      expect(chunk.content.length).toBeLessThanOrEqual(MEMORY_EMBEDDING_MAX_TOKENS);
      expect(content.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.content);
    }
    expect(splits[0]).toBe(content.length);
  });

  it("covers the whole original between the pieces it produced", async () => {
    const content = "а".repeat(700) + " " + "б".repeat(700);

    const fitted = await fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure: tokensPerCharacter,
    });

    expect(fitted[0]?.startOffset).toBe(0);
    expect(fitted[fitted.length - 1]?.endOffset).toBe(content.length);
    for (const [index, chunk] of fitted.entries()) {
      if (index === 0) continue;
      // Pieces never overlap, and whatever lies between two of them is whitespace only.
      const gap = content.slice(fitted[index - 1]!.endOffset, chunk.startOffset);
      expect({ ordered: chunk.startOffset >= fitted[index - 1]!.endOffset, gap })
        .toEqual({ ordered: true, gap: gap.trim() === "" ? gap : "не пробелы" });
    }
  });

  it("splits text that has no whitespace to split on", async () => {
    const content = "а".repeat(1_500);

    const fitted = await fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure: tokensPerCharacter,
    });

    expect(fitted.length).toBeGreaterThan(1);
    for (const chunk of fitted) {
      expect(chunk.content.length).toBeLessThanOrEqual(MEMORY_EMBEDDING_MAX_TOKENS);
    }
  });

  it("fails loudly when the text cannot be divided far enough", async () => {
    const content = "а".repeat(40_000);

    await expect(fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure: tokensPerCharacter,
    })).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_INPUT_INVALID/);
  });

  it("refuses a token count that does not match the chunks it was given", async () => {
    const content = "Любой текст";

    await expect(fitMemoryChunksToTokenLimit({
      chunks: wholeText(content),
      content,
      measure: () => Promise.resolve([1, 2]),
    })).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID/);
  });
});
