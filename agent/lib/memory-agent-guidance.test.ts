/**
 * Agent memory-guidance regression tests.
 *
 * Constructs covered:
 * - The permanent prompt defines bounded context deepening before complex answers or actions.
 * - The explicit search tool advertises iterative semantic retrieval to the model.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import searchMemories from "../tools/search_memories.js";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);

describe("agent memory guidance", () => {
  it("requires bounded multi-query context deepening for complex requests", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).toContain("## Углубление контекста");
    expect(instructions).toContain("до трёх последовательных вызовов `search_memories`");
    expect(instructions).toContain("с разными смысловыми формулировками");
    expect(instructions).toContain("Остановись раньше");
    expect(instructions).toContain("`glob`, `grep` и `read_file`");
    expect(instructions).toContain("Не повторяй автоматически неудачный вызов");
  });

  it("tells the model to use semantic search iteratively when context is incomplete", () => {
    expect(searchMemories.description).toContain("углубления контекста");
    expect(searchMemories.description).toContain("до трёх раз");
    expect(searchMemories.description).toContain("разными смысловыми формулировками");
    expect(searchMemories.description).toContain("остановись");
  });
});
