/**
 * Slang, abbreviations and transliteration the search also reads in their plain form.
 *
 * Constructs covered:
 * - The synthetic and live forms get their plain word; inflected forms count.
 * - Look-alike words and lower-case «др» are left alone.
 * - Property: the person's own text is kept as written, and adding twice adds nothing more.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { withQueryAliases } from "./memory-query-aliases.js";

describe("withQueryAliases", () => {
  it.each([
    ["Кто чинит тачку?", "Кто чинит тачку? машина автомобиль"],
    ["Какой комп выдали на работе?", "Какой комп выдали на работе? компьютер"],
    ["Скинь репу Ладоги", "Скинь репу Ладоги репозиторий"],
    ["Сколько стоит инет?", "Сколько стоит инет? интернет"],
    ["Когда ДР у Алёны?", "Когда ДР у Алёны? день рождения"],
    ["Во сколько дейли у Ладоги?", "Во сколько дейли у Ладоги? ежедневный созвон"],
    ["Как гостям подключиться к вайфаю?", "Как гостям подключиться к вайфаю? Wi-Fi"],
    ["напомни свой гитхаб", "напомни свой гитхаб GitHub"],
    ["на чём Артём кеширует нжинкс?", "на чём Артём кеширует нжинкс? nginx"],
    ["куда уходит бэкап, на гитхаб?", "куда уходит бэкап, на гитхаб? резервная копия GitHub"],
  ])("reads «%s» in plain words too", (text, expected) => {
    expect(withQueryAliases(text)).toBe(expected);
  });

  it.each([
    "компания переехала", "компот из яблок", "Иван, Пётр и др.", "репетиция в пятницу",
    "машина на ремонте", "ремонт GitHub Actions на гитхабе GitHub",
  ])("leaves «%s» as it is", (text) => {
    expect(withQueryAliases(text)).toBe(text);
  });

  it("keeps the person's words and adds nothing on a second pass", () => {
    const filler = fc.constantFrom("где", "когда", "скинь", "у Алёны", "на работе", "?", "ну", "");
    const alias = fc.constantFrom("тачка", "комп", "репу", "ДР", "днюха", "гитхабе", "докер", "инет", "дейли");
    const text = fc.array(fc.oneof(filler, alias), { maxLength: 6 }).map((parts) => parts.join(" "));

    fc.assert(fc.property(text, (original) => {
      const once = withQueryAliases(original);
      expect(once.startsWith(original)).toBe(true);
      expect(withQueryAliases(once)).toBe(once);
    }), { examples: [["ДР ДР днюха"]] });
  });
});
