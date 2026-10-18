/**
 * The skills of a step without a sandbox until a skill with files is loaded.
 *
 * Constructs covered:
 * - `createStepSkillAccess`: instructions-only skills never open the sandbox; a skill with files is
 *   written alone; a live conversation tidies the skill root on its first sandbox use, keeping only
 *   the granted skills that have files; a schedule or a delegated task only adds; a skill not granted,
 *   or withdrawn since the turn listed it, is refused by name; definitions are read once per step.
 */
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSandboxSession } from "../sandbox/types.js";
import type { SkillDefinition } from "../skills/definition.js";
import { createStepSkillAccess } from "./turn-skills.js";

const DEFINITIONS: Record<string, SkillDefinition> = {
  digest: { description: "Сводки", markdown: "Пиши коротко." },
  pdf: { description: "PDF", files: { "forms.md": "Формы", "scripts/fill.py": "print()" }, markdown: "Заполняй формы." },
};

function access(options: { granted?: string[]; tidy?: boolean; definitions?: Record<string, SkillDefinition> } = {}) {
  const syncSkills = vi.fn<RuntimeSandboxSession["syncSkills"]>(async () => undefined);
  const sandbox = { syncSkills } as unknown as RuntimeSandboxSession;
  const openSandbox = vi.fn(async () => sandbox);
  const resolveDefinitions = vi.fn(async () => options.definitions ?? DEFINITIONS);
  const step = createStepSkillAccess({
    granted: options.granted ?? ["digest", "pdf"], openSandbox, resolveDefinitions, tidy: options.tidy ?? true,
  });
  const calls = () => syncSkills.mock.calls.map(([packages, keep]) => ({
    keep, packages: packages.map((pkg) => [pkg.name, pkg.files.map((file) => file.relativePath)]),
  }));
  return { calls, openSandbox, resolveDefinitions, step };
}

describe("step skill access", () => {
  it("returns an instructions-only skill without opening the sandbox", async () => {
    const { openSandbox, step } = access();

    await expect(step.loadSkill("digest")).resolves.toEqual({ files: null, markdown: "Пиши коротко." });
    expect(openSandbox).not.toHaveBeenCalled();
  });

  it("tidies once on the first sandbox use, then writes only the loaded skill, keeping the skills with files", async () => {
    const { calls, openSandbox, step } = access();

    await expect(step.loadSkill("pdf")).resolves.toEqual({
      files: { directory: "$HOME/.agents/skills/pdf", paths: ["forms.md", "scripts/fill.py"] },
      markdown: "Заполняй формы.",
    });
    await step.getSandbox();
    expect(openSandbox).toHaveBeenCalledOnce();
    expect(calls()).toEqual([
      { keep: ["pdf"], packages: [] },
      { keep: ["pdf"], packages: [["pdf", ["SKILL.md", "forms.md", "scripts/fill.py"]]] },
    ]);
  });

  it("only adds in a schedule or a delegated task, which share the home with live turns", async () => {
    const { calls, step } = access({ tidy: false });

    await step.getSandbox();
    await step.loadSkill("pdf");
    expect(calls()).toEqual([{ keep: null, packages: [["pdf", ["SKILL.md", "forms.md", "scripts/fill.py"]]] }]);
  });

  it("refuses a skill the turn does not list and names the listed ones", async () => {
    const { resolveDefinitions, step } = access();

    await expect(step.loadSkill("secret")).rejects.toThrow('No skill named "secret". Available skills: digest, pdf.');
    expect(resolveDefinitions).not.toHaveBeenCalled();
  });

  it("refuses a listed skill withdrawn after the turn listed it", async () => {
    const { calls, step } = access({ definitions: { digest: DEFINITIONS.digest! } });

    await expect(step.loadSkill("pdf")).rejects.toThrow('No skill named "pdf".');
    expect(calls()).toEqual([]);
  });

  it("reads the definitions once per step", async () => {
    const { resolveDefinitions, step } = access();

    await step.getSandbox();
    await step.loadSkill("digest");
    await step.loadSkill("pdf");
    expect(resolveDefinitions).toHaveBeenCalledOnce();
  });
});
