/**
 * Document skill supporting-file contract tests.
 *
 * Constructs covered:
 * - PDF supporting-file links match Linux case-sensitive package paths.
 * - DOCX and XLSX scripts are invoked from their materialized skill roots.
 * - The DOCX quick start imports every Node.js module it uses.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function skillFile(skill: string, file = "SKILL.md"): Promise<string> {
  return await readFile(new URL(`../../../config/skills/${skill}/${file}`, import.meta.url), "utf8");
}

describe("document skill packages", () => {
  it("uses exact PDF supporting-file names and executable script paths", async () => {
    const skill = await skillFile("pdf");
    const forms = await skillFile("pdf", "forms.md");

    expect(skill).toContain("reference.md");
    expect(skill).toContain("forms.md");
    expect(skill).not.toMatch(/REFERENCE\.md|FORMS\.md/u);
    expect(forms).toContain("$HOME/.agents/skills/pdf/scripts/check_fillable_fields.py");
    expect(forms).not.toMatch(/python scripts\//u);
  });

  it.each(["docx", "xlsx"])("anchors %s scripts at the sandbox skill root", async (skillName) => {
    const skill = await skillFile(skillName);

    expect(skill).not.toMatch(/python scripts\//u);
    expect(skill).toContain(`$HOME/.agents/skills/${skillName}/scripts/`);
    if (skillName === "xlsx") {
      expect(skill).not.toContain("Use the scripts/recalc.py script");
      expect(skill).not.toContain("provided `scripts/recalc.py` script");
    }
  });

  it("imports fs before the DOCX quick start writes a file", async () => {
    const skill = await skillFile("docx");

    expect(skill.indexOf("require('node:fs')")).toBeLessThan(skill.indexOf("fs.writeFileSync"));
  });
});
