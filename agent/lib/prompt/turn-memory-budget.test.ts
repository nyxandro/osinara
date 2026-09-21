import { describe, expect, it } from "vitest";

import { MEMORY_TURN_BLOCK_MAX_CHARACTERS } from "../memory-config.js";
import type { ModelMemoryContextItem } from "../memory-retrieval.js";
import { applyTurnMemoryBudget, turnMemoryBlockCharacters } from "./turn-memory-budget.js";

function record(ref: string, characters: number): ModelMemoryContextItem {
  return { content: "я".repeat(characters), kind: "fact", memoryRef: ref } as ModelMemoryContextItem;
}

function conflict(ref: string, characters: number): ModelMemoryContextItem {
  return {
    type: "unresolved_conflict",
    versions: [{ content: "я".repeat(characters), memoryRef: ref }],
  } as unknown as ModelMemoryContextItem;
}

describe("applyTurnMemoryBudget", () => {
  it("keeps every record when the assembled block fits the budget", () => {
    const memories = [record("mem_first", 1_000), record("mem_second", 1_000)];

    const result = applyTurnMemoryBudget({ memories, otherCharacters: 2_000 });

    expect(result.memories).toEqual(memories);
    expect(result.droppedMemories).toBe(0);
  });

  it("drops whole records from the tail of the ranking until the block fits", () => {
    const memories = [
      record("mem_first", 12_000),
      record("mem_second", 12_000),
      record("mem_third", 12_000),
      record("mem_fourth", 12_000),
    ];

    const result = applyTurnMemoryBudget({ memories, otherCharacters: 10_000 });

    expect(result.memories).toEqual([memories[0], memories[1]]);
    expect(result.droppedMemories).toBe(2);
    expect(turnMemoryBlockCharacters(result.memories, 10_000))
      .toBeLessThanOrEqual(MEMORY_TURN_BLOCK_MAX_CHARACTERS);
  });

  it("never truncates a kept record", () => {
    const memories = [record("mem_first", 20_000), record("mem_second", 20_000)];

    const result = applyTurnMemoryBudget({ memories, otherCharacters: 4_000 });

    expect(result.memories).toEqual([memories[0]]);
    expect((result.memories[0] as { content: string }).content).toHaveLength(20_000);
  });

  it("drops plain records before an unresolved conflict, whatever its place in the ranking", () => {
    const memories = [
      record("mem_first", 12_000),
      conflict("mem_conflict", 12_000),
      record("mem_third", 12_000),
      record("mem_fourth", 12_000),
    ];

    const result = applyTurnMemoryBudget({ memories, otherCharacters: 10_000 });

    expect(result.memories).toEqual([memories[0], memories[1]]);
    expect(result.droppedMemories).toBe(2);
  });

  it("drops conflicts from the tail only when no plain record is left to drop", () => {
    const memories = [conflict("mem_one", 20_000), conflict("mem_two", 20_000)];

    const result = applyTurnMemoryBudget({ memories, otherCharacters: 4_000 });

    expect(result.memories).toEqual([memories[0]]);
    expect(result.droppedMemories).toBe(1);
  });

  it("returns no records rather than a truncated one when the rest of the block fills the budget", () => {
    const memories = [record("mem_first", 4_000)];

    const result = applyTurnMemoryBudget({
      memories,
      otherCharacters: MEMORY_TURN_BLOCK_MAX_CHARACTERS,
    });

    expect(result.memories).toEqual([]);
    expect(result.droppedMemories).toBe(1);
  });

  it("measures the block the same way the retrieval metrics line does", () => {
    const memories = [record("mem_first", 100)];

    expect(turnMemoryBlockCharacters(memories, 500)).toBe(JSON.stringify(memories).length + 500);
  });
});
