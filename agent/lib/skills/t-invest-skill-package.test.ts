/**
 * Native T-Invest skill package tests.
 *
 * Constructs covered:
 * - Skill package frontmatter and trigger description copied from the canonical local skill.
 * - Bundled CLI and JSON field reference are present inside the skill package.
 */
import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const skillRoot = new URL("../../skills/t-invest/", import.meta.url);
const skillFile = new URL("SKILL.md", skillRoot);
const referenceFile = new URL("references/json-fields.md", skillRoot);
const cliFile = new URL("scripts/tinvest.cjs", skillRoot);

async function readSkill(): Promise<string> {
  return await readFile(skillFile, "utf8");
}

describe("T-Invest skill package", () => {
  it("declares the canonical native skill frontmatter", async () => {
    const skill = await readSkill();

    expect(skill).toContain("---\nname: t-invest\n");
    expect(skill).toContain("description: Access to the user's Т-Инвестиции");
  });

  it("retains routing terms for portfolio, income, and ticker requests", async () => {
    const skill = await readSkill();

    expect(skill).toContain("portfolio");
    expect(skill).toContain("dividends");
    expect(skill).toContain("SBER");
  });

  it("bundles the deterministic CLI and JSON interpretation reference", async () => {
    await expect(access(cliFile)).resolves.toBeUndefined();
    await expect(access(referenceFile)).resolves.toBeUndefined();

    const skill = await readSkill();
    const reference = await readFile(referenceFile, "utf8");

    expect(skill).toContain("scripts/tinvest.cjs");
    expect(skill).toContain("references/json-fields.md");
    expect(reference).toContain("`null` означает");
  });

  it("keeps secrets outside the skill package", async () => {
    const skill = await readSkill();

    expect(skill).toContain("~/.config/tinvest/.env");
    expect(skill).toContain("Токены НЕ хранятся в папке скилла");
  });
});
