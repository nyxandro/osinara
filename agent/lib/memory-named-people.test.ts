/**
 * Preferring the person a question names over people it does not.
 *
 * Constructs covered:
 * - Names in any case form and @handles identify a person; topics and the bot's name do not.
 * - Another person's record is lowered below the named person's, not removed.
 * - Property: re-ranking loses and duplicates no record, and leaves the order of everything it
 *   does not lower untouched.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { namedPeople, preferNamedPeople } from "./memory-named-people.js";
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

const NINA = "Нина Соколова (nina_s)";
const TIMUR = "Тимур Галеев (@tgaleev)";

function result(id: string, score: number, subjectLabel: string | null): ScoredMemoryRetrievalResult {
  return {
    evidence: { russianMorphologyRank: null, semanticSimilarity: 0.84, simpleLexicalRank: null },
    exactDuplicateIdentity: id,
    memory: { id, memoryRef: `mem_${id}` } as ScoredMemoryRetrievalResult["memory"],
    score,
    subjectLabel,
  };
}

describe("namedPeople", () => {
  it.each([
    ["что Нина говорила про Стаю?", [NINA, TIMUR], ["nina_s"]],
    ["а у Нины что?", [NINA], ["nina_s"]],
    ["с Тимуром говорили?", [TIMUR], ["tgaleev"]],
    ["@tgaleev, что скажешь?", [TIMUR], ["tgaleev"]],
    ["кто тут пользуется Ульем?", [NINA, TIMUR], []],
    // Topics, groups of subjects and the bot are not people.
    ["что Осинара умеет?", ["Осинара", "Осинара / Мия", "Ilya Kruglov — система памяти"], []],
    ["никто не знает?", ["Ник Петров (nick_p)"], []],
  ])("in «%s»", (query, labels, expected) => {
    expect([...namedPeople(query, labels)]).toEqual(expected);
  });
});

describe("preferNamedPeople", () => {
  it("puts the named person's records above a neighbour's on the same topic", () => {
    const ranked = [result("timur-staya", 0.04, TIMUR), result("nina-memory", 0.03, NINA), result("staya-docs", 0.025, null)];

    expect(preferNamedPeople("что Нина говорила про Стаю?", ranked).map((one) => one.memory.id))
      .toEqual(["nina-memory", "staya-docs", "timur-staya"]);
  });

  it("changes nothing when the question names nobody", () => {
    const ranked = [result("timur-staya", 0.04, TIMUR), result("nina-memory", 0.03, NINA)];

    expect(preferNamedPeople("кто что думает про Стаю?", ranked)).toEqual(ranked);
  });

  it("loses no record and keeps the order of everything it does not lower", () => {
    const labels = fc.constantFrom(NINA, TIMUR, "Вика Лунина (vlunina)", "Осинара", null);
    const ranked = fc.array(fc.tuple(fc.double({ max: 1, min: 0, noNaN: true }), labels), { maxLength: 20 })
      .map((rows) => rows
        .sort(([left], [right]) => right - left)
        .map(([score, label], index) => result(`r${index}`, score, label)));
    const query = fc.constantFrom("что Нина говорила?", "а Тимур?", "кто что думает?", "Нина и Вика где?");

    fc.assert(fc.property(ranked, query, (records, text) => {
      const reranked = preferNamedPeople(text, records);
      const named = namedPeople(text, records.map((one) => one.subjectLabel));
      const kept = (one: ScoredMemoryRetrievalResult) => named.size === 0 || one.subjectLabel === null ||
        one.subjectLabel === "Осинара" || [...named].some((handle) => one.subjectLabel!.includes(handle));

      expect(reranked.map((one) => one.memory.id).sort()).toEqual(records.map((one) => one.memory.id).sort());
      expect(reranked.filter(kept).map((one) => one.memory.id)).toEqual(records.filter(kept).map((one) => one.memory.id));
    }), { examples: [[[result("a", 0.5, TIMUR), result("b", 0.5, NINA)], "что Нина говорила?"]] });
  });
});
