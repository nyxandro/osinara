/**
 * A saved skill must not run from its draft folder.
 *
 * Constructs covered:
 * - `requireNoDraftPathReference`: the draft path in the instructions or in a script is refused with
 *   the file named; the installed path `$HOME/.agents/skills/<name>/` and other skills' paths pass.
 */
import { describe, expect, it } from "vitest";

import { requireNoDraftPathReference } from "./draft-path-check.js";

const skill = (markdown: string, files: Record<string, string> = {}) => ({
  files: Object.entries(files).map(([path, content]) => ({ content: Buffer.from(content), path })),
  markdown,
  name: "doc-signing",
});

describe("draft path check", () => {
  it("refuses the draft folder wherever the package names it", () => {
    for (const package_ of [
      skill("cd /workspace/personal\npython3 skills/doc-signing/scripts/sign_pdf.py"),
      skill("Скрипт: /workspace/personal/skills/doc-signing/scripts/sign_pdf.py"),
      skill("Запусти скрипт.", { "scripts/run.sh": "python3 skills/doc-signing/scripts/sign_pdf.py" }),
    ]) {
      expect(() => requireNoDraftPathReference(package_)).toThrowError(expect.objectContaining({ code: "AGENT_SKILL_DRAFT_PATH_REFERENCE" }));
    }
    expect(() => requireNoDraftPathReference(skill("x", { "scripts/run.sh": "skills/doc-signing/x" })))
      .toThrowError(/scripts\/run\.sh ссылается на черновик/u);
  });

  it("lets the installed path and other skills' folders through", () => {
    expect(() => requireNoDraftPathReference(skill(
      "python3 $HOME/.agents/skills/doc-signing/scripts/sign_pdf.py\nСм. также skills/pdf/forms.md и /tools/personal/home/.agents/skills/doc-signing/",
    ))).not.toThrow();
  });
});
