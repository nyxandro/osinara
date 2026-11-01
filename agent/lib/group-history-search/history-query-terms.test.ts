/**
 * How a history query becomes the words a message must contain.
 *
 * Constructs covered:
 * - `historyQueryTerms`: every distinct word of three letters or more, up to eight, each with its
 *   spelling in the other alphabet; a query of only short words keeps them; punctuation drops.
 * - `transliterateWord`: Cyrillic to Latin and back the way people type names and slang.
 * - `historyTextClause`: one condition per word, values only as numbered parameters, wildcards escaped.
 */
import { describe, expect, it } from "vitest";

import { historyQueryTerms, historyTextClause, transliterateWord } from "./history-query-terms.js";

describe("transliterateWord", () => {
  it.each([
    ["похуй", "pohuy"],
    ["скилл", "skill"],
    ["шима", "shima"],
    ["щука", "schuka"],
    ["юля", "yulya"],
    ["pohuy", "похуй"],
    ["skill", "скилл"],
    ["shima", "шима"],
    ["zhuk", "жук"],
  ])("spells %s as %s", (word, spelled) => {
    expect(transliterateWord(word)).toBe(spelled);
  });

  it("leaves a word of mixed alphabets or with digits as it is", () => {
    expect(transliterateWord("ag2")).toBeNull();
    expect(transliterateWord("pohуй")).toBeNull();
  });
});

describe("historyQueryTerms", () => {
  it("asks for every word in any order, each in both alphabets", () => {
    expect(historyQueryTerms("Похуй, скилл!").map((term) => term.variants.slice(0, 2))).toEqual([
      ["похуй", "pohuy"],
      ["скилл", "skill"],
    ]);
  });

  it("reads a word typed in the wrong keyboard layout as well", () => {
    expect(historyQueryTerms("ghbdtn")[0]!.variants).toContain("привет");
    expect(historyQueryTerms("руддщ")[0]!.variants).toContain("hello");
  });

  it("finds «е» for a typed «ё»", () => {
    expect(historyQueryTerms("ещё")[0]!.variants).toEqual(expect.arrayContaining(["ещё", "еще", "esche"]));
  });

  it("drops short words beside longer ones, keeps them when nothing else is asked, and repeats nothing", () => {
    expect(historyQueryTerms("ссылка на pohuy и pohuy").map((term) => term.variants[0])).toEqual(["ссылка", "pohuy"]);
    expect(historyQueryTerms("ок да").map((term) => term.variants[0])).toEqual(["ок", "да"]);
  });

  it("keeps at most eight words and nothing for a query without letters or digits", () => {
    expect(historyQueryTerms("один два три четыре пять шесть семь восемь девять десять")).toHaveLength(8);
    expect(historyQueryTerms("?!…")).toEqual([]);
  });
});

describe("historyTextClause", () => {
  it("checks every word through parameters numbered after the caller's, with LIKE wildcards escaped", () => {
    const { clause, parameters } = historyTextClause([{ variants: ["ссылку"] }, { variants: ["50%_off"] }], 11);

    expect(clause).toBe(
      " AND (message.content_text ILIKE $11" +
      " OR to_tsvector('russian', coalesce(message.content_text, '')) @@ plainto_tsquery('russian', $12)" +
      " OR $13 <% message.content_text)" +
      " AND (message.content_text ILIKE $14)",
    );
    expect(parameters).toEqual(["%ссылку%", "ссылку", "ссылку", "%50\\%\\_off%"]);
  });

  it("matches numbers and short words only as typed, never loosely", () => {
    const { clause } = historyTextClause(historyQueryTerms("123456 похуй"), 1);

    expect(clause).not.toContain("$1 <%");
    expect(clause.match(/<%/gu)).toBeNull();
  });
});
