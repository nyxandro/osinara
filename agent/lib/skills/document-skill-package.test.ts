/**
 * Document skill supporting-file contract tests.
 *
 * Constructs covered:
 * - PDF supporting-file links match Linux case-sensitive package paths.
 * - DOCX and XLSX scripts are invoked from their materialized skill roots.
 * - The sandbox image ships every program the DOCX and XLSX skills call; on 2026-10-19 the agent
 *   found no LibreOffice there and had to work around the skill.
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

  it("ships in the sandbox image every program the DOCX and XLSX skills call", async () => {
    const docx = await skillFile("docx");
    const xlsx = await skillFile("xlsx");
    const dockerfile = await readFile(new URL("../../../Dockerfile", import.meta.url), "utf8");
    const sandboxTools = JSON.parse(
      await readFile(new URL("../../../infra/sandbox-tools/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const runtimeStage = dockerfile.slice(
      dockerfile.indexOf("AS sandbox-runtime"), dockerfile.indexOf("AS sandbox-runner"),
    );

    expect(docx).toContain("require('docx')");
    expect(sandboxTools.dependencies).toHaveProperty("docx");
    expect(docx).toContain("pandoc -t markdown");
    expect(docx).toContain("pdftoppm");
    expect(`${docx}\n${xlsx}`).toContain("soffice.py");
    for (const apt of ["libreoffice-calc", "libreoffice-writer", "pandoc", "poppler-utils"]) {
      expect(runtimeStage, apt).toMatch(new RegExp(`^\\s+${apt} \\\\$`, "mu"));
    }
  });
});
