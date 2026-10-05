import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool } from "../tool.js";
import { estimateFrameTokens, estimateTextTokens } from "./compaction-estimate.js";
import { toModelToolSet } from "./model-tools.js";

describe("frame estimate", () => {
  it("counts the system prompt by its UTF-8 size and each tool with its JSON schema", async () => {
    const fieldDescription = "Текст заметки. ".repeat(200);
    const tools = toModelToolSet([["note", defineTool({
      description: "Записать заметку",
      execute: () => "ok",
      inputSchema: z.object({ text: z.string().describe(fieldDescription) }),
    })]]);

    const system = "Ты Осинара.";
    const frame = await estimateFrameTokens(system, tools);

    // The field description lives only in the schema: an unresolved schema would drop it.
    expect(frame).toBeGreaterThan(estimateTextTokens(system) + estimateTextTokens(fieldDescription));
    expect(await estimateFrameTokens(system, {})).toBe(estimateTextTokens(system) + estimateTextTokens("[]"));
  });
});
