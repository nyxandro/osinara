import { describe, expect, it } from "vitest";

import { FAMILY_SKILL_LIMITS, validateSkillPackage } from "./package-validation.js";

const text = (path: string, content: string) => ({ content: Buffer.from(content, "utf8"), path });
const manifest = (frontmatter: string, body = "# Как пользоваться\n") => text("SKILL.md", `---\n${frontmatter}\n---\n${body}`);

describe("skill package validation", () => {
  it("reads the name, description and body, and marks the scripts among the files", () => {
    const validated = validateSkillPackage({
      files: [
        manifest("name: weather\ndescription: Прогноз погоды по городу"),
        text("scripts/fetch.py", "print('ok')"),
        text("bin/run", "#!/bin/sh\necho ok"),
        text("README.txt", "Описание"),
        text("Makefile", "all:"),
        text("tool.php", "<?php"),
        text(".git/config", "служебный"),
        text("scripts/__pycache__/fetch.cpython-312.pyc", "x"),
      ],
      limits: FAMILY_SKILL_LIMITS,
    });

    expect(validated).toMatchObject({ description: "Прогноз погоды по городу", markdown: "# Как пользоваться\n", name: "weather" });
    expect(validated.files.map(({ executable, path, size }) => ({ executable, path, size }))).toEqual([
      { executable: true, path: "Makefile", size: 4 },
      { executable: false, path: "README.txt", size: 16 },
      { executable: true, path: "bin/run", size: 17 },
      { executable: true, path: "scripts/fetch.py", size: 11 },
      { executable: true, path: "tool.php", size: 5 },
    ]);
    expect(validated.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["no SKILL.md", [text("run.sh", "echo")], "нет файла SKILL.md"],
    ["no frontmatter", [text("SKILL.md", "# Просто текст")], "должен начинаться с заголовка"],
    ["no description", [manifest("name: weather")], "нет описания"],
    ["a bad name", [manifest("name: Погода\ndescription: Прогноз")], "строчных латинских букв"],
    ["an unsafe path", [manifest("name: weather\ndescription: Прогноз"), text("../escape.sh", "x")], "Недопустимый путь"],
  ])("refuses a package with %s, saying what is wrong", (_case, files, message) => {
    expect(() => validateSkillPackage({ files, limits: FAMILY_SKILL_LIMITS })).toThrow(expect.objectContaining({
      code: "AGENT_SKILL_PACKAGE_INVALID", message: expect.stringContaining(message),
    }));
  });

  it("holds a family's skill to the size limits, but not a reviewed built-in one", () => {
    const big = { content: new Uint8Array(FAMILY_SKILL_LIMITS.maxFileBytes + 1), path: "data.bin" };
    const files = [manifest("name: weather\ndescription: Прогноз"), big];

    expect(() => validateSkillPackage({ files, limits: FAMILY_SKILL_LIMITS })).toThrow("больше 1 МБ");
    expect(validateSkillPackage({ files, limits: null }).files).toHaveLength(1);
  });

  it("makes a family skill's description one bounded line, and keeps a built-in one as written", () => {
    const files = [manifest("name: weather\ndescription: |\n  Прогноз\n  ## Раздел\u202e")];

    expect(validateSkillPackage({ files, limits: FAMILY_SKILL_LIMITS }).description).toBe("Прогноз ## Раздел");
    expect(validateSkillPackage({ files, limits: null }).description).toBe("Прогноз\n## Раздел\u202e");
    expect(() => validateSkillPackage({ files: [manifest(`name: weather\ndescription: ${"a".repeat(1025)}`)], limits: FAMILY_SKILL_LIMITS }))
      .toThrow("длиннее 1024 знаков");
  });

  it("requires a built-in skill's declared name to match its folder", () => {
    const files = [manifest("name: other\ndescription: Прогноз")];

    expect(() => validateSkillPackage({ expectedName: "weather", files, limits: null })).toThrow("не совпадает с папкой");
    expect(validateSkillPackage({ expectedName: "weather", files: [manifest("description: Прогноз")], limits: null }).name).toBe("weather");
  });
});
