/**
 * Recognising a message that asks memory nothing.
 *
 * Constructs covered:
 * - Greetings, thanks, laughter and acknowledgements from the synthetic and golden sets are small talk.
 * - Any word outside the vocabulary — a name, a thing, a request — makes a message a question.
 * - Property: a message built only from small-talk phrases, in any case and with any punctuation,
 *   is small talk, and one word from outside the vocabulary anywhere in it makes it not.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { prepareMemoryQuery } from "./memory-query-preparation.js";
import { isSmallTalkMessage, SMALL_TALK_PHRASES } from "./memory-small-talk.js";

const smallTalk = (message: string) => isSmallTalkMessage(prepareMemoryQuery(message));

describe("isSmallTalkMessage", () => {
  it.each([
    "привет", "куку", "Умница", "Осинара, умница", "спасибо, понял", "Осинара, ты тут?", "ахахах",
    "доброе утро!", "как дела?", "просто проверка связи, ничего не надо", "+1", "ну всё, я спать",
    "просто тест. ничего не надо", "Ок 👍", "хаха)))", "Спасибо!!! Нет, просто молодец",
  ])("recognises «%s» as small talk", (message) => {
    expect(smallTalk(message)).toBe(true);
  });

  it.each([
    // A question, however short: memory may hold its answer.
    "Кому нельзя орехи?", "так ты обрезана", "Колобок всему голова?", "ты на каком железе крутишься?",
    "какие у тебя гардрейлы?", "Where is the training project backup stored?", "Что было в Суздле?",
    "а на чем мы остановились", "Что было вчера?", "спасибо, а где ключи от гаража?", "привет, Нина",
    // Chatter in ordinary words is missed on purpose: the price of never silencing a question.
    "звучит как сериал", "ты подшофе?",
    "", "   ", "!!!",
  ])("does not silence «%s»", (message) => {
    expect(smallTalk(message)).toBe(false);
  });

  it("leaves a long message to the search even when every word is small talk", () => {
    expect(smallTalk("да да да да да да да да да")).toBe(false);
  });

  it("keeps small talk small talk until a word from outside the vocabulary enters it", () => {
    expect(SMALL_TALK_PHRASES.filter((phrase) => /^[фщцzqw]/u.test(phrase))).toEqual([]);
    const phrase = fc.constantFrom(...SMALL_TALK_PHRASES);
    const casing = fc.constantFrom(
      (text: string) => text,
      (text: string) => text.toUpperCase(),
      (text: string) => text[0]!.toUpperCase() + text.slice(1),
    );
    const separator = fc.constantFrom(" ", ", ", "! ", "? ", "... ", " :) ", " — ");
    // Words that cannot be in the vocabulary, decided without the function under test: no phrase
    // or laughter starts with these letters.
    const outsideWord = fc.stringMatching(/^[фщцzqw][а-яa-z]{2,8}$/u);
    const message = fc.array(fc.tuple(phrase, casing, separator), { minLength: 1, maxLength: 3 })
      .map((parts) => parts.map(([text, recase, gap]) => `${recase(text)}${gap}`).join(""));

    fc.assert(fc.property(message, outsideWord, fc.nat(), (text, word, at) => {
      expect(isSmallTalkMessage(text)).toBe(true);
      const parts = text.split(" ");
      parts.splice(at % (parts.length + 1), 0, word);
      expect(isSmallTalkMessage(parts.join(" "))).toBe(false);
    }), { examples: [["ну всё, я спать", "фото", 2], ["ахаха", "жена", 0]] });
  });
});
