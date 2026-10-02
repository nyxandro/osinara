import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "./frontmatter.js";

describe("SKILL.md frontmatter", () => {
  it("folds a multi-line description the way YAML does, keeping its paragraphs", () => {
    const parsed = parseSkillFrontmatter([
      "---",
      "name: find-docs",
      "description: >-",
      "  Retrieves up-to-date documentation for any",
      "  developer technology.",
      "",
      "  Always use for: API syntax questions.",
      "metadata:",
      "  version: \"1.0\"",
      "license: MIT",
      "---",
      "# Body",
    ].join("\n"));

    expect(parsed).toEqual({
      body: "# Body",
      fields: {
        description: "Retrieves up-to-date documentation for any developer technology.\nAlways use for: API syntax questions.",
        license: "MIT",
        name: "find-docs",
      },
    });
  });

  it("reads plain, quoted and literal values and the chomping of block scalars", () => {
    const parsed = parseSkillFrontmatter([
      "---",
      "name: \"docx\"",
      "description: 'Работа с документами: чтение и правка'",
      "notes: |",
      "  первая строка",
      "    с отступом",
      "keep: >+",
      "  текст",
      "",
      "---",
      "",
    ].join("\n"));

    expect(parsed?.fields).toEqual({
      description: "Работа с документами: чтение и правка",
      keep: "текст\n\n",
      name: "docx",
      notes: "первая строка\n  с отступом\n",
    });
  });

  it("finds no frontmatter in a file that does not start with one", () => {
    expect(parseSkillFrontmatter("# Только текст\n")).toBeNull();
  });

  it("gives back a folded description as its paragraphs, however its lines were wrapped", () => {
    const word = fc.stringMatching(/^[A-Za-zА-Яа-я0-9.,!?()'":-]{1,12}$/u);
    const paragraph = fc.array(word, { maxLength: 30, minLength: 1 });
    fc.assert(fc.property(fc.array(paragraph, { maxLength: 4, minLength: 1 }), fc.integer({ max: 6, min: 1 }), (paragraphs, width) => {
      const block = paragraphs.map((words) => {
        const lines: string[] = [];
        for (let start = 0; start < words.length; start += width) lines.push(`  ${words.slice(start, start + width).join(" ")}`);
        return lines.join("\n");
      }).join("\n\n");
      const parsed = parseSkillFrontmatter(`---\nname: wrapped\ndescription: >-\n${block}\n---\nbody`);
      expect(parsed?.fields.description).toBe(paragraphs.map((words) => words.join(" ")).join("\n"));
    }));
  });
});
