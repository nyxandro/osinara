/**
 * Memory query preparation contract tests.
 *
 * Constructs covered:
 * - A vocative address to the assistant is removed; the assistant named as a subject survives.
 * - Emoji, variation selectors, and Markdown emphasis leave, the words they wrapped stay.
 * - Identifiers that carry underscores or dots are not mistaken for emphasis.
 * - Preparation never returns an empty query: a message that is only an address stays as it was.
 * - The application's notice in place of an API key leaves; the owner's words around it in one burst
 *   stay, and a notice alone stays as it was, for the abstention check to recognise.
 */
import { describe, expect, it } from "vitest";

import { prepareMemoryQuery } from "./memory-query-preparation.js";
import { apiKeyDeliveredModelText, isApiKeyDeliveredModelText } from "./telegram-model-placeholders.js";

const VARIABLES = { apiKey: "GROQ_API_KEY", baseUrl: "GROQ_BASE_URL" };

describe("prepareMemoryQuery", () => {
  it.each([
    ["Осинара, напомни код от домофона", "напомни код от домофона"],
    ["Осинара привет, какой у нас тариф на интернет?", "привет, какой у нас тариф на интернет?"],
    ["Асинара, привет", "привет"],
    ["Слушай, Осинара, когда у Петра день рождения?", "Слушай, когда у Петра день рождения?"],
    ["@osinara_bot напомни про резину", "напомни про резину"],
    ["@osinara_bot, напомни про резину", "напомни про резину"],
  ])("removes the address in %j", (input, expected) => {
    expect(prepareMemoryQuery(input)).toBe(expected);
  });

  it.each([
    "Где репозиторий Осинары?",
    "Дай ссылку на исходный код Осинары.",
    "Что умеет Осинара в группах?",
    // No comma marks this as an address, and the name may be the subject of the sentence.
    // Keeping a word never loses information; removing one can.
    "Осинара умеет читать PDF?",
    "Осинары логи где лежат?",
    "осинара скажи пожалуйста где аптечка",
  ])("keeps the assistant named as the subject of the question in %j", (input) => {
    expect(prepareMemoryQuery(input)).toBe(input);
  });

  it.each([
    "@petya какой у него телефон?",
    "Напомни, @petya, про страховку",
    "Петя, напомни про страховку",
  ])("never removes a mention of somebody else in %j", (input) => {
    expect(prepareMemoryQuery(input)).toBe(input);
  });

  it.each([
    ["🎂 когда днюха у Алёны?", "когда днюха у Алёны?"],
    ["Напомни 🚲 номер рамы велосипеда Петра", "Напомни номер рамы велосипеда Петра"],
    ["Где ключ ❤️‍🔥 от дачи", "Где ключ от дачи"],
  ])("removes emoji from %j", (input, expected) => {
    expect(prepareMemoryQuery(input)).toBe(expected);
  });

  it.each([
    ["**Важно**: какой код от калитки?", "Важно: какой код от калитки?"],
    ["__Срочно__ где документы на квартиру", "Срочно где документы на квартиру"],
    ["Что такое `search_vector`?", "Что такое search_vector?"],
    ["~~старое~~ новое правило про экраны", "старое новое правило про экраны"],
    ["> Напомни номер полиса", "Напомни номер полиса"],
  ])("removes Markdown from %j", (input, expected) => {
    expect(prepareMemoryQuery(input)).toBe(expected);
  });

  it.each([
    "Что такое memory_items и чем оно отличается от memory_items_all?",
    "Ссылка https://code.example/ladoga/core ещё жива?",
    "Тикер LDGA и счётчик ХВ-118420",
  ])("leaves identifiers, links, and codes untouched in %j", (input) => {
    expect(prepareMemoryQuery(input)).toBe(input);
  });

  it.each(["Осинара,", "@osinara_bot", "🎂"])(
    "returns the original when preparation would empty the query %j",
    (input) => {
      expect(prepareMemoryQuery(input)).toBe(input);
    },
  );

  it.each([true, false])("keeps only the owner's words around an API key notice (applied: %s)", (applied) => {
    const notice = apiKeyDeliveredModelText({ applied, name: "groq", variables: VARIABLES });

    expect(prepareMemoryQuery(`${notice}\n\nОсинара, а теперь расшифруй это видео`)).toBe("а теперь расшифруй это видео");
    expect(prepareMemoryQuery(`что с ключом?\n\n${notice}`)).toBe("что с ключом?");
    expect(isApiKeyDeliveredModelText(prepareMemoryQuery(notice))).toBe(true);
  });

  it.each(["a", "a__b", "osinara", "a".repeat(32)])("recognises the notice for the key name %j", (name) => {
    const notice = apiKeyDeliveredModelText({
      applied: true, name, variables: { apiKey: `${name.toUpperCase()}_API_KEY`, baseUrl: `${name.toUpperCase()}_BASE_URL` },
    });

    expect(isApiKeyDeliveredModelText(prepareMemoryQuery(notice))).toBe(true);
    expect(isApiKeyDeliveredModelText(prepareMemoryQuery(`${notice} держи`))).toBe(false);
  });

  it("collapses the whitespace left behind by everything it removed", () => {
    expect(prepareMemoryQuery("Осинара,   напомни    🎂   про  торт"))
      .toBe("напомни про торт");
  });
});
