/**
 * How a history query becomes the words a message must contain, and the SQL that checks them.
 *
 * Exports:
 * - `transliterateWord`: a word's spelling in the other alphabet, the way people type names and slang.
 * - `historyQueryTerms`: the words of a query, each with its spellings.
 * - `historyTextClause`: the condition a message meets when it holds every word of the query.
 *
 * Key constructs:
 * - A message matches when it holds every word, in any order. A word counts as held when its text
 *   occurs in the message, when a Russian form of it does («ссылку» finds «ссылка»), when its
 *   spelling in the other alphabet occurs («похуй» finds «pohuy»), or, for a word of six letters or
 *   more, when the message holds a close word (a small typo, pg_trgm `<%`). Numbers never match
 *   loosely: «123456» must not find «123457».
 * - Words of one or two letters only narrow a query that has nothing longer: «на», «и» occur in
 *   almost every message.
 * - The words reach SQL only as parameters; the LIKE wildcards in them are escaped.
 */
const MAX_TERMS = 8;
const SHORT_WORD_LENGTH = 3;
// pg_trgm's word similarity is too loose for short words: «похуй» would match «похуже».
const FUZZY_MIN_LENGTH = 6;

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
// Longest first: «sch» before «sh», «kh» before «k».
const LATIN_TO_CYRILLIC: readonly (readonly [string, string])[] = [
  ["shch", "щ"], ["sch", "щ"], ["zh", "ж"], ["kh", "х"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"],
  ["yu", "ю"], ["ya", "я"], ["yo", "ё"], ["ye", "е"],
  ["a", "а"], ["b", "б"], ["c", "к"], ["d", "д"], ["e", "е"], ["f", "ф"], ["g", "г"], ["h", "х"], ["i", "и"],
  ["j", "й"], ["k", "к"], ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["q", "к"], ["r", "р"],
  ["s", "с"], ["t", "т"], ["u", "у"], ["v", "в"], ["w", "в"], ["x", "кс"], ["z", "з"],
];
const LATIN_VOWELS = new Set(["a", "e", "i", "o", "u"]);

function latinToCyrillic(word: string): string {
  let spelled = "";
  for (let index = 0; index < word.length;) {
    // «y» after a vowel is «й» (pohuy → похуй), otherwise «ы»; «ya», «yu» are read above as digraphs.
    if (word[index] === "y" && !["yu", "ya", "yo", "ye"].includes(word.slice(index, index + 2))) {
      spelled += index > 0 && LATIN_VOWELS.has(word[index - 1]!) ? "й" : "ы";
      index += 1;
      continue;
    }
    const pair = LATIN_TO_CYRILLIC.find(([latin]) => word.startsWith(latin, index))!;
    spelled += pair[1];
    index += pair[0].length;
  }
  return spelled;
}

export function transliterateWord(word: string): string | null {
  if (/^[а-яё]+$/u.test(word)) return [...word].map((letter) => CYRILLIC_TO_LATIN[letter]).join("");
  if (/^[a-z]+$/u.test(word)) return latinToCyrillic(word);
  return null;
}

export interface HistoryQueryTerm {
  /** The word as typed, its «е» spelling when it has «ё», then its spelling in the other alphabet. */
  variants: string[];
}

export function historyQueryTerms(query: string): HistoryQueryTerm[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const long = words.filter((word) => word.length >= SHORT_WORD_LENGTH);
  return (long.length > 0 ? long : words).slice(0, MAX_TERMS).map((word) => {
    const spelled = transliterateWord(word);
    // People rarely type «ё»: «ещё» must find «еще».
    const plain = word.replaceAll("ё", "е");
    return { variants: [...new Set([word, plain, ...(spelled ? [spelled] : [])])] };
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

/**
 * `AND (...)` per word, with its values as parameters numbered from `firstParameter`. Every
 * predicate has an index of its own (migration 144): trigram for the text and the close word,
 * the Russian text search vector for word forms.
 */
export function historyTextClause(
  terms: readonly HistoryQueryTerm[],
  firstParameter: number,
): { clause: string; parameters: string[] } {
  const parameters: string[] = [];
  const next = (value: string) => `$${firstParameter + parameters.push(value) - 1}`;
  const clauses = terms.map(({ variants }) => {
    // One ILIKE per spelling, not ILIKE ANY: a GIN index serves a plain OR, not an array comparison.
    const predicates = variants.map((variant) => `message.content_text ILIKE ${next(`%${escapeLike(variant)}%`)}`);
    for (const variant of variants) {
      if (/^[а-яё]+$/u.test(variant) && variant.length >= SHORT_WORD_LENGTH) {
        predicates.push(`to_tsvector('russian', coalesce(message.content_text, '')) @@ plainto_tsquery('russian', ${next(variant)})`);
      }
      if (/^\p{L}+$/u.test(variant) && variant.length >= FUZZY_MIN_LENGTH) predicates.push(`${next(variant)} <% message.content_text`);
    }
    return ` AND (${predicates.join(" OR ")})`;
  });
  return { clause: clauses.join(""), parameters };
}
