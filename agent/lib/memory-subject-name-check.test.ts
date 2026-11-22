/**
 * Whom a record's text names, against whom it is bound to (#556).
 *
 * Constructs covered:
 * - `mentionedUsernames`: «@handle», «(handle)» and «(@handle)», whatever the case; a bare word, an
 *   e-mail address and a longer handle that merely starts the same are not mentions.
 * - `subjectNameMismatch`: another participant named while the bound person is not; passes when the
 *   bound person is named too, and ignores handles that belong to nobody in the chat.
 * - Property: the form and the case of a mention never decide whether it is found.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mentionedUsernames, subjectNameMismatch } from "./memory-subject-name-check.js";

describe("mentionedUsernames", () => {
  it.each([
    ["Нина Соколова (nina_s) любит Postgres", ["nina_s"]],
    ["Нина (@Nina_S) и @oleg_p", ["nina_s", "oleg_p"]],
    ["( @nina_s ) пишет", ["nina_s"]],
    ["Нина (nina_s, сестра @oleg_p)", ["nina_s", "oleg_p"]],
    ["nina_s без формы упоминания", []],
    ["почта nina@gmail.com", []],
    ["@nina_s_backup", ["nina_s_backup"]],
    ["использует Postgres (pgvector)", ["pgvector"]],
  ])("in «%s»", (content, expected) => {
    expect([...mentionedUsernames(content)]).toEqual(expected);
  });
});

describe("subjectNameMismatch", () => {
  const others = ["oleg_p", "timur_t"];

  it("names the other participants when the bound person is not named", () => {
    expect(subjectNameMismatch("Нина Соколова (nina_s) любит Postgres", "oleg_p", ["nina_s", "timur_t"]))
      .toEqual(["nina_s"]);
  });

  it("passes when the bound person is named as well", () => {
    expect(subjectNameMismatch("Олег (@OLEG_P) работает с Ниной (nina_s)", "oleg_p", ["nina_s"])).toBeNull();
    expect(subjectNameMismatch("Нина (nina_s, сестра @oleg_p) любит Postgres", "nina_s", ["oleg_p"])).toBeNull();
  });

  it("passes a text that names nobody, or only people outside the chat", () => {
    expect(subjectNameMismatch("Любит Postgres", "nina_s", others)).toBeNull();
    expect(subjectNameMismatch("Читает канал @durov", "nina_s", others)).toBeNull();
  });

  it("finds a mention whatever its form and case", () => {
    const handle = fc.constantFrom(...others);
    const form = fc.constantFrom((h: string) => `@${h}`, (h: string) => `(${h})`, (h: string) => `(@${h})`);
    const casing = fc.constantFrom((h: string) => h, (h: string) => h.toUpperCase(),
      (h: string) => h[0]!.toUpperCase() + h.slice(1));
    const words = fc.array(fc.constantFrom("любит", "Postgres", "и", "Нина", "работает"), { maxLength: 6 });

    fc.assert(fc.property(handle, form, casing, words, words, (name, wrap, cased, before, after) => {
      const content = [...before, wrap(cased(name)), ...after].join(" ");
      expect(subjectNameMismatch(content, "nina_s", others)).toEqual([name]);
    }));
  });
});
