/**
 * Recognising a message that asks memory nothing.
 *
 * Exports:
 * - `SMALL_TALK_PHRASES`: the closed vocabulary a small-talk message is made of.
 * - `isSmallTalkMessage`: true when every word of the prepared message belongs to it.
 *
 * The automatic selection used to fill its twelve places whatever the message was: «привет»,
 * «спасибо, понял» or «+1» each brought up to twelve unrelated records. The model did not repeat
 * them (layer 4 of the memory measurements), but read them on every such turn (#341).
 *
 * Why words and not the search's own scores: no score separates the two. Against real memory a
 * greeting's nearest record sits at 0.815, where a synthetic paraphrase's right answer sits too;
 * "no word of the message is in memory" also holds for a question in English or in transliteration,
 * which only the meaning branch can answer. A message made of nothing but greetings, thanks,
 * laughter and acknowledgements is small talk whatever the memory holds; one word outside that
 * vocabulary — a name, a thing, a verb that asks for something — and the search runs as before.
 * The vocabulary will miss chatter that uses ordinary words, and that is the accepted price:
 * missing chatter costs tokens, missing a question costs an answer.
 */

/**
 * Phrases, each a sequence of words. A message is small talk when its words split into these
 * phrases with nothing left over. Multi-word phrases exist where a word alone would carry meaning:
 * «добрый вечер» is a greeting, «вечер» is a question about the evening.
 */
export const SMALL_TALK_PHRASES: readonly string[] = [
  // Приветствия, прощания, пинг.
  "привет", "приветик", "приветствую", "здравствуй", "здравствуйте", "здорово", "здарова", "хай",
  "хей", "йо", "ку", "куку", "салют", "доброе утро", "добрый день", "добрый вечер", "доброй ночи",
  "спокойной ночи", "пока", "покеда", "до свидания", "до завтра", "увидимся", "бывай", "ау", "алло",
  "ты тут", "ты здесь", "проверка связи", "тест", "я спать", "пойду спать",
  // Как дела.
  "как дела", "как ты", "как жизнь", "как сам", "как сама",
  // Благодарность и похвала.
  "спасибо", "спасибочки", "спс", "благодарю", "мерси", "умница", "молодец", "молодчина",
  "красава", "класс", "классно", "круто", "супер", "отлично", "огонь", "кайф", "шикарно",
  // Согласие, подтверждение, отказ.
  "ок", "окей", "ok", "okay", "лады", "ладно", "понял", "поняла", "понятно", "ясно", "принято",
  "ага", "угу", "да", "нет", "неа", "конечно", "точно", "верно", "согласен", "согласна", "+1",
  "ничего не надо", "не надо",
  // Смех и междометия.
  "лол", "ору", "кек", "ржу", "хд", "xd",
  // Связки, которые сами ничего не спрашивают.
  "ну", "а", "и", "вот", "же", "просто", "всё", "все", "ой", "эх", "ох", "ах", "хм",
];


// «аха», «ахаха», «хахах», «хехе», «хих», «ммм»: laughter and hums are spelled at any length.
const LAUGHTER_PATTERN = /^(?:а?(?:х[аеи])+х?|м{2,})$/u;
// Small talk is short. A long message made only of these words is still a message, and silence
// is the wrong default for anything that took a person more than a line to write.
const MAX_SMALL_TALK_WORDS = 8;

function words(text: string): string[] {
  return text
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .match(/\+1|[\p{L}\p{N}]+/gu) ?? [];
}

// Phrases go through the same normalisation as the message, «всё» and «все» included.
const PHRASE_KEYS = new Set(SMALL_TALK_PHRASES.map((phrase) => words(phrase).join(" ")));
const LONGEST_PHRASE = Math.max(...SMALL_TALK_PHRASES.map((phrase) => words(phrase).length));

/** The text as `prepareMemoryQuery` returns it: the address to the assistant already removed. */
export function isSmallTalkMessage(prepared: string): boolean {
  const tokens = words(prepared);
  if (tokens.length === 0 || tokens.length > MAX_SMALL_TALK_WORDS) return false;
  // Whether the words split into phrases with nothing left over: position i is reachable when the
  // words before it split. Exact for any vocabulary, so a phrase added later cannot break it.
  const reachable = Array.from({ length: tokens.length + 1 }, (_, index) => index === 0);
  for (let start = 0; start < tokens.length; start += 1) {
    if (!reachable[start]) continue;
    if (LAUGHTER_PATTERN.test(tokens[start]!)) reachable[start + 1] = true;
    for (let length = 1; length <= Math.min(LONGEST_PHRASE, tokens.length - start); length += 1) {
      if (PHRASE_KEYS.has(tokens.slice(start, start + length).join(" "))) reachable[start + length] = true;
    }
  }
  return reachable[tokens.length]!;
}
