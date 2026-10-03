import { describe, expect, it } from "vitest";

import { MEMORY_TURN_BLOCK_MAX_CHARACTERS } from "../memory-config.js";
import type { ModelMemoryContextItem } from "../memory-retrieval.js";
import { applyTurnMemoryBudget } from "./turn-memory-budget.js";

/** Stands in for the assembled block: a fixed wrapper plus the records themselves. */
function render(memories: readonly ModelMemoryContextItem[], otherCharacters = 0): string {
  return "w".repeat(WRAPPER_CHARACTERS + otherCharacters) + JSON.stringify(memories);
}

const WRAPPER_CHARACTERS = 2_500;

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

    const result = applyTurnMemoryBudget({ memories, render: (kept) => render(kept, 2_000) });

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

    const result = applyTurnMemoryBudget({ memories, render: (kept) => render(kept, 10_000) });

    expect(result.memories).toEqual([memories[0], memories[1]]);
    expect(result.droppedMemories).toBe(2);
    expect(render(result.memories, 10_000).length)
      .toBeLessThanOrEqual(MEMORY_TURN_BLOCK_MAX_CHARACTERS);
  });

  it("never truncates a kept record", () => {
    const memories = [record("mem_first", 20_000), record("mem_second", 20_000)];

    const result = applyTurnMemoryBudget({ memories, render: (kept) => render(kept, 4_000) });

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

    const result = applyTurnMemoryBudget({ memories, render: (kept) => render(kept, 10_000) });

    expect(result.memories).toEqual([memories[0], memories[1]]);
    expect(result.droppedMemories).toBe(2);
  });

  it("drops conflicts from the tail only when no plain record is left to drop", () => {
    const memories = [conflict("mem_one", 20_000), conflict("mem_two", 20_000)];

    const result = applyTurnMemoryBudget({ memories, render: (kept) => render(kept, 4_000) });

    expect(result.memories).toEqual([memories[0]]);
    expect(result.droppedMemories).toBe(1);
  });

  it("keeps the best match even when the rest of the block already fills the budget", () => {
    const memories = [record("mem_first", 4_000), record("mem_second", 4_000)];

    const result = applyTurnMemoryBudget({
      memories,
      render: (kept) => render(kept, MEMORY_TURN_BLOCK_MAX_CHARACTERS),
    });

    expect(result.memories).toEqual([memories[0]]);
    expect(result.droppedMemories).toBe(1);
    expect(result.overBudget).toBe(true);
  });

  it("reports a block that fits so the caller stays quiet", () => {
    const result = applyTurnMemoryBudget({
      memories: [record("mem_first", 1_000)],
      render: (kept) => render(kept, 1_000),
    });

    expect(result.overBudget).toBe(false);
  });

  it("measures the assembled block, not the records on their own", () => {
    // The wrapper and the instructions around the records are two and a half thousand characters
    // on production, and escaping adds more: a budget blind to them overshoots its own ceiling.
    const memories = [record("mem_first", MEMORY_TURN_BLOCK_MAX_CHARACTERS - WRAPPER_CHARACTERS)];

    expect(applyTurnMemoryBudget({ memories, render }).overBudget).toBe(true);
  });
});
