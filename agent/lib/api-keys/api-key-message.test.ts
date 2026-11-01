/**
 * Telling the owner's message apart while an API key is awaited.
 *
 * Constructs covered:
 * - A message that is one printable token is the key, with invisible characters a copy brought along
 *   removed; a key among words, or with letters a key cannot have, is a secret to withhold; Russian
 *   text, links, e-mail and site names are ordinary messages that reach the agent.
 * - Properties: a generated key alone, padded or broken by an invisible character, is that key; the
 *   same key among arbitrary Russian words is never ordinary; text without a long printable run is
 *   ordinary.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { classifyApiKeyMessage } from "./api-key-message.js";

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const WORD_JOINER = String.fromCodePoint(0x2060);
const CYRILLIC_E = String.fromCodePoint(0x0435);
const KEY_CHARACTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"];
// A real key mixes letters and digits; the generator builds that in instead of filtering.
const generatedKey = fc.tuple(
  fc.array(fc.constantFrom(...KEY_CHARACTERS), { maxLength: 60, minLength: 14 }),
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
  fc.constantFrom(..."0123456789"),
).map(([body, letter, digit]) => `sk-${letter}${digit}${body.join("")}`);
const russianWords = fc.array(
  fc.array(fc.constantFrom(..."абвгдежзийклмнопрстуфхцчшщыэюя"), { maxLength: 24, minLength: 1 }).map((letters) => letters.join("")),
  { maxLength: 6, minLength: 1 },
);

describe("API key message classification", () => {
  it.each([
    "sk-live-1234567890abcdefghij",
    "  sk-proj-AbCdEf1234567890_xyz\n",
    "a3f9c2e1b7d84f60a3f9c2e1b7d84f60",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig_Abc-123",
  ])("takes %j for the key", (text) => {
    expect(classifyApiKeyMessage(text)).toEqual({ kind: "key", value: text.trim() });
  });

  it("drops an invisible character a copy brought into the key", () => {
    expect(classifyApiKeyMessage(`${WORD_JOINER}sk-live-12345678${ZERO_WIDTH_SPACE}90abcdefghij`))
      .toEqual({ kind: "key", value: "sk-live-1234567890abcdefghij" });
  });

  it.each([
    "вот ключ: sk-live-1234567890abcdefghij",
    "sk-live-1234567890abcdefghij\nэто от NeuralDeep",
    `sk-live-1234567890abcd${CYRILLIC_E}fghij`,
  ])("withholds %j as a secret", (text) => {
    expect(classifyApiKeyMessage(text)).toEqual({ kind: "secret" });
  });

  it.each([
    "а где взять ключ?",
    "достопримечательности профессионального уровня",
    "https://docs.neuraldeep.ru/api/keys",
    "смотри https://example.com/v1/models123 там всё",
    "напиши на ivan.petrov2024@example.com",
    "docs.example.com/v2/reference",
    "ок",
  ])("lets %j through as an ordinary message", (text) => {
    expect(classifyApiKeyMessage(text)).toEqual({ kind: "ordinary" });
  });

  it("takes any generated key alone for that key, padded or broken by an invisible character", () => {
    fc.assert(fc.property(generatedKey, fc.constantFrom("", " ", "\n"), fc.nat(), (key, padding, cut) => {
      const at = cut % (key.length + 1);
      expect(classifyApiKeyMessage(`${padding}${key}${padding}`)).toEqual({ kind: "key", value: key });
      expect(classifyApiKeyMessage(`${key.slice(0, at)}${ZERO_WIDTH_SPACE}${key.slice(at)}`))
        .toEqual({ kind: "key", value: key });
    }));
  });

  it("never lets a key among Russian words through", () => {
    fc.assert(fc.property(generatedKey, russianWords, russianWords, (key, before, after) => {
      expect(classifyApiKeyMessage([...before, key, ...after].join(" "))).toEqual({ kind: "secret" });
    }), { examples: [[`sk-a1${"b".repeat(14)}`, ["вот"], ["ключ"]]] });
  });

  it("treats text without a long printable run as ordinary", () => {
    const shortRuns = fc.array(
      fc.oneof(fc.string({ maxLength: 15, unit: "grapheme-ascii" }), russianWords.map((words) => words.join(" "))),
      { maxLength: 8 },
    ).map((parts) => parts.join(" ").replace(/[\x21-\x7E]{16,}/gu, "x"));
    fc.assert(fc.property(shortRuns, (text) => {
      expect(classifyApiKeyMessage(text)).toEqual({ kind: "ordinary" });
    }));
  });
});
