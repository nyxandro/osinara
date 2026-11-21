/**
 * Preferring the person a question names over people it does not.
 *
 * Constructs covered:
 * - Names in any case form and @handles identify a person; topics and the bot's name do not.
 * - Another person's record is lowered below the named person's, not removed.
 * - A record bound to a person is recognised by the binding, without a text label: by the current
 *   username, by the Telegram name, and for a person with no username by the binding itself (#556).
 * - The asker's own records are never lowered: «что я обещал Нине?» names Нина, not the one asking.
 * - Property: re-ranking loses and duplicates no record, and leaves the order of everything it
 *   does not lower untouched.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { namedPeople, preferNamedPeople } from "./memory-named-people.js";
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

const NINA = "Нина Соколова (nina_s)";
const TIMUR = "Тимур Галеев (@tgaleev)";

function result(
  id: string,
  score: number,
  subjectLabel: string | null,
  subjectPerson: ScoredMemoryRetrievalResult["subjectPerson"] = null,
): ScoredMemoryRetrievalResult {
  return {
    evidence: { russianMorphologyRank: null, semanticSimilarity: 0.84, simpleLexicalRank: null },
    exactDuplicateIdentity: id,
    memory: { id, memoryRef: `mem_${id}` } as ScoredMemoryRetrievalResult["memory"],
    score,
    subjectLabel,
    subjectPerson,
  };
}

const labelled = (labels: readonly (string | null)[]) =>
  labels.map((subjectLabel) => ({ subjectLabel, subjectPerson: null }));

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
    expect([...namedPeople(query, labelled(labels))]).toEqual(expected);
  });
});

describe("preferNamedPeople", () => {
  it("puts the named person's records above a neighbour's on the same topic", () => {
    const ranked = [result("timur-staya", 0.04, TIMUR), result("nina-memory", 0.03, NINA), result("staya-docs", 0.025, null)];

    expect(preferNamedPeople("что Нина говорила про Стаю?", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-memory", "staya-docs", "timur-staya"]);
  });

  it("recognises a bound person without a label, by name and by username", () => {
    const nina = { key: "participant:nina", name: "Нина Соколова", telegramUserId: "1", username: "nina_s" };
    const timur = { key: "participant:timur", name: "Тимур", telegramUserId: "2", username: null };
    const ranked = [result("timur-staya", 0.04, null, timur), result("nina-memory", 0.03, null, nina)];

    expect(preferNamedPeople("что Нина говорила про Стаю?", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-memory", "timur-staya"]);
    // Тимур has no username: the binding itself tells him apart.
    expect(preferNamedPeople("а Тимур что думает про Стаю?", ranked, null).map((one) => one.memory.id))
      .toEqual(["timur-staya", "nina-memory"]);
  });

  it("tells namesakes apart by the username the question names", () => {
    const ninaS = { key: "participant:nina-s", name: "Нина", telegramUserId: "1", username: "nina_s" };
    const ninaI = { key: "participant:nina-i", name: "Нина", telegramUserId: "3", username: "Nina_I" };
    const ranked = [result("nina-i", 0.04, null, ninaI), result("nina-s", 0.03, null, ninaS)];

    expect(preferNamedPeople("что знает @nina_s?", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-s", "nina-i"]);
    expect(preferNamedPeople("что знает @nina_i?", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-i", "nina-s"]);
    // Both are Нина: the name alone lowers neither.
    expect(preferNamedPeople("что Нина говорила?", ranked, null)).toEqual(ranked);
  });

  it("never lowers the asker's own records", () => {
    const nina = { key: "participant:nina", name: "Нина Соколова", telegramUserId: "1", username: "nina_s" };
    const oleg = { key: "participant:oleg", name: "Олег", telegramUserId: "2", username: "oleg_p" };
    const ranked = [result("oleg-promise", 0.04, null, oleg), result("nina-memory", 0.03, null, nina)];

    expect(preferNamedPeople("что я обещал купить Нине?", ranked, "2")).toEqual(ranked);
    expect(preferNamedPeople("что я обещал купить Нине?", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-memory", "oleg-promise"]);
  });

  it("takes a label and a binding with the same username for one person", () => {
    const nina = { key: "participant:nina", name: "Нина Соколова", telegramUserId: "1", username: "nina_s" };
    const ranked = [result("timur", 0.05, TIMUR), result("nina-label", 0.04, NINA), result("nina-bound", 0.03, null, nina)];

    expect(preferNamedPeople("@nina_s", ranked, null).map((one) => one.memory.id))
      .toEqual(["nina-label", "nina-bound", "timur"]);
  });

  it("changes nothing when the question names nobody", () => {
    const ranked = [result("timur-staya", 0.04, TIMUR), result("nina-memory", 0.03, NINA)];

    expect(preferNamedPeople("кто что думает про Стаю?", ranked, null)).toEqual(ranked);
  });

  it("loses no record and keeps the order of everything it does not lower", () => {
    const labels = fc.constantFrom(NINA, TIMUR, "Вика Лунина (vlunina)", "Осинара", null);
    const ranked = fc.array(fc.tuple(fc.double({ max: 1, min: 0, noNaN: true }), labels), { maxLength: 20 })
      .map((rows) => rows
        .sort(([left], [right]) => right - left)
        .map(([score, label], index) => result(`r${index}`, score, label)));
    const query = fc.constantFrom("что Нина говорила?", "а Тимур?", "кто что думает?", "Нина и Вика где?");

    fc.assert(fc.property(ranked, query, (records, text) => {
      const reranked = preferNamedPeople(text, records, null);
      const named = namedPeople(text, records);
      const kept = (one: ScoredMemoryRetrievalResult) => named.size === 0 || one.subjectLabel === null ||
        one.subjectLabel === "Осинара" || [...named].some((handle) => one.subjectLabel!.includes(handle));

      expect(reranked.map((one) => one.memory.id).sort()).toEqual(records.map((one) => one.memory.id).sort());
      expect(reranked.filter(kept).map((one) => one.memory.id)).toEqual(records.filter(kept).map((one) => one.memory.id));
    }), { examples: [[[result("a", 0.5, TIMUR), result("b", 0.5, NINA)], "что Нина говорила?"]] });
  });
});
