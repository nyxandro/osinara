/**
 * Complete model-facing tool surface contract test.
 *
 * Constructs covered:
 * - Private, family, external, scheduled-external, subagent, and memory-review surfaces.
 * - The shared call contract is stated once in the permanent core, not on every descriptor.
 * - Every emitted tool still carries its own purpose and stays inside the compact size budget.
 * - External path overrides retain the narrower group-relative contract.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMemoryReviewToolSurface } from "./memory-review/memory-review-tool-surface.js";
import { EXTERNAL_GROUP_TOOL_NAMES } from "./tool-policy/group-tool-catalog.js";
import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "./tool-policy/mode-tool-surface.js";

// The generic contract used to be appended to every descriptor. It now lives once here, so the
// surfaces stay small while the rules the model needs are still guaranteed to reach it.
const REQUIRED_CORE_RULES = [
  "только когда его назначение прямо соответствует текущей задаче",
  "Передавай только поля схемы этого инструмента",
  "только по успешному результату инструмента",
  "sideEffectStatus",
] as const;
const TOTAL_DESCRIPTION_MAX_CHARACTERS = 25_000;

function surfaces() {
  const externalInput = {
    capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
    environment: "external" as const,
    includeApplicationCore: true,
    scheduledHistory: false,
    skills: {},
  };
  return {
    external: buildModeToolSurface(externalInput),
    family: buildModeToolSurface({ environment: "family" }),
    memoryReview: buildMemoryReviewToolSurface("family"),
    private: buildModeToolSurface({ environment: "private" }),
    scheduledExternal: buildModeToolSurface({
      ...externalInput,
      scheduledHistory: true,
      scheduledRun: true,
    }),
    subagent: buildSubagentToolSurface(externalInput),
  };
}

describe("model-facing tool contracts", () => {
  it("walks every emitted mode surface and requires a complete compact descriptor", () => {
    for (const [surfaceName, surface] of Object.entries(surfaces())) {
      expect(Object.keys(surface).length, `${surfaceName} must emit tools`).toBeGreaterThan(0);
      const totalDescriptionCharacters = Object.values(surface)
        .reduce((total, definition) => total + definition.description.length, 0);
      expect(totalDescriptionCharacters, `${surfaceName} total prompt size`)
        .toBeLessThanOrEqual(TOTAL_DESCRIPTION_MAX_CHARACTERS);
      for (const [toolName, definition] of Object.entries(surface)) {
        expect(definition.inputSchema, `${surfaceName}.${toolName} input schema`).toBeDefined();
        expect(typeof definition.execute, `${surfaceName}.${toolName} executor`).toBe("function");
        expect(definition.description.length, `${surfaceName}.${toolName} prompt size`)
          .toBeLessThan(4_000);
        expect(definition.description.trim(), `${surfaceName}.${toolName} states its purpose`)
          .not.toBe("");
      }
    }
  });

  it("states the shared tool call contract once in the permanent core", () => {
    const core = readFileSync(resolve("agent/instructions.md"), "utf8");

    for (const rule of REQUIRED_CORE_RULES) {
      expect(core, `permanent core missing ${rule}`).toContain(rule);
    }
  });

  it("keeps external image and delivery paths relative while native file paths stay absolute", () => {
    const external = surfaces().external;

    expect(external.send_workspace_file!.description).toContain("reports/result.pdf");
    expect(external.send_workspace_file!.description).toContain("не передавай /workspace/group");
    expect(external.inspect_workspace_image!.description).toContain("photos/image.png");
    expect(external.read_file!.description).toContain("/workspace/group");
  });
});
