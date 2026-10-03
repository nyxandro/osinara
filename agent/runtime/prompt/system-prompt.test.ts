import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { unpackReferenceFile, type ReferenceFile } from "../testing/model-request-reference.js";
import { composeBasePrompt, composeSystemPrompt } from "./system-prompt.js";
import { formatAvailableSkillsSection } from "./skills-section.js";

const REFERENCE_DIRECTORY = "agent/runtime/testing/reference-requests";

async function firstSystemPrompt(scenario: string): Promise<string> {
  const file = JSON.parse(await readFile(`${REFERENCE_DIRECTORY}/${scenario}.json`, "utf8")) as ReferenceFile;
  const request = unpackReferenceFile(file)[0]!.request as { prompt: Array<{ content: unknown; role: string }> };
  const system = request.prompt.find((message) => message.role === "system");
  if (typeof system?.content !== "string") throw new Error(`TEST_REFERENCE_SYSTEM_MISSING: ${scenario}`);
  return system.content;
}

async function productionInstructions() {
  return { name: "instructions", content: await readFile("agent/instructions.md", "utf8") };
}

describe("system prompt composition", () => {
  it.each(["private-first", "family-group", "external-human", "external-bot", "memory-review", "scheduled-isolated"])(
    "starts with the reference base prompt (%s)",
    async (scenario) => {
      const base = composeBasePrompt({ instructions: await productionInstructions(), toolsAvailable: true });

      expect((await firstSystemPrompt(scenario)).startsWith(`${base}\n\n`)).toBe(true);
    },
  );

  it("leaves out the parallel tool rule when no tool is available", async () => {
    const base = composeBasePrompt({ instructions: { name: "instructions", content: "\n# Правила\n" }, toolsAvailable: false });

    expect(base).toBe("Instructions (instructions)\n# Правила");
  });

  it("joins the base prompt, turn blocks and the skill list exactly as the recorded request", async () => {
    const recorded = await firstSystemPrompt("external-bot");
    const base = composeBasePrompt({ instructions: await productionInstructions(), toolsAvailable: true });
    const skillsStart = recorded.lastIndexOf("\n\nAvailable skills\n");
    const turnBlocks = recorded.slice(base.length + 2, skillsStart).split("\n\n<").map((block, index) => index === 0 ? block : `<${block}`);
    const skillLine = recorded.slice(recorded.lastIndexOf("\n- pohuy: ") + "\n- pohuy: ".length, recorded.lastIndexOf(" (path: "));

    expect(composeSystemPrompt({
      base,
      instructionBlocks: turnBlocks,
      skillsSection: formatAvailableSkillsSection([{ name: "pohuy", description: skillLine }], { skillRoot: "/.agents/skills" }),
    })).toBe(recorded);
  });

  it("ends with the turn blocks when no skill is announced", () => {
    expect(composeSystemPrompt({ base: "B", instructionBlocks: ["M1", "M2"], skillsSection: null })).toBe("B\n\nM1\n\nM2");
  });
});

describe("available skills section", () => {
  it("is absent for an empty skill list", () => {
    expect(formatAvailableSkillsSection([], { skillRoot: "/home/agent/.agents/skills" })).toBeNull();
  });

  it("points every skill at its SKILL.md under the sandbox skill root", () => {
    expect(formatAvailableSkillsSection([{ name: "pdf", description: "PDF files" }], { skillRoot: "/home/agent/.agents/skills" }))
      .toContain("Skill files live under `/home/agent/.agents/skills/<skill>/`.\nWhen a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.\n- pdf: PDF files (path: /home/agent/.agents/skills/pdf/SKILL.md)");
  });
});
