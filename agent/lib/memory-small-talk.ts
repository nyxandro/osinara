/**
 * Recognising a message that asks memory nothing.
 *
 * Exports:
 * - `SMALL_TALK_PHRASES`: the closed vocabulary a small-talk message is made of.
 * - `isSmallTalkMessage`: true when every word of the prepared message belongs to it; the assistant's
 *   name in a form of address, or a mention of its account, is no word of the question, and a bare
 *   call by name is small talk.
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
 *
 * The first vocabulary held only the textbook phrases and did not silence one of 190 live turns
 * (2026-10-09..16): people wrote «Осинара ты лучшая», «Позже», «Вы обе молодец.», «да не, отдыхай».
 * Two causes, both fixed here. The name without a comma stays in the search text, because without
 * the comma it may be the subject of a question («Осинара умеет читать PDF?»), and it was then a word
 * outside the vocabulary. And the live forms of putting off, letting go, praise and agreement were
 * missing. The additions are still words that ask nothing by themselves: next to a verb or a thing
 * («позже напомни про врача») the message goes to the search as before.
 */
import { AGENT_NAME_STEM_SOURCE } from "./agent-name.js";

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
  "ничего не надо", "не надо", "не", "так и есть", "это главное",
  // Отложить и отпустить: ответ на предложение ассистента, а не вопрос к памяти.
  "позже", "попозже", "потом", "не сейчас", "подожди", "погоди", "отдыхай", "отдохни", "спи",
  // Похвала и симпатия, в том числе обоим ассистентам сразу.
  "лучшая", "лучший", "умничка", "умнички", "молодцы", "четко", "респект", "браво", "топ", "люблю",
  "one love",
  // Обращение с похвалой. Только целыми сочетаниями: одно «а ты?» — встречный вопрос ассистенту
  // о нём самом, и память о нём нужна (#346).
  "ты лучшая", "ты лучший", "ты топ", "ты молодец", "ты умница", "ты умничка", "ты супер",
  "ты огонь", "ты класс", "вы молодцы", "вы лучшие", "вы супер", "вы обе", "вы оба",
  // Смех и междометия.
  "лол", "ору", "кек", "ржу", "хд", "xd", "воу", "вау", "ого", "ух", "о",
  // Связки, которые сами ничего не спрашивают.
  "ну", "а", "и", "вот", "же", "просто", "всё", "все", "ой", "эх", "ох", "ах", "хм",
];


// «аха», «ахаха», «хахах», «хехе», «хих», «ммм»: laughter and hums are spelled at any length.
const LAUGHTER_PATTERN = /^(?:а?(?:х[аеи])+х?|м{2,})$/u;
// Small talk is short. A long message made only of these words is still a message, and silence
// is the wrong default for anything that took a person more than a line to write.
const MAX_SMALL_TALK_WORDS = 8;
// The assistant's name as an address: nominative or diminutive («Осинара», «Осинарочка»). An oblique
// case («а Осинары?») is a question about the assistant and stays a word. A mention of the bot
// account is removed whole, as the word split would otherwise cut it into «osinara» and «bot».
const AGENT_NAME_ADDRESS_PATTERN = new RegExp(`^(?:${AGENT_NAME_STEM_SOURCE})(?:а|a|очка|ушка|онька)?$`, "u");
const AGENT_MENTION_PATTERN = new RegExp(`@(?:${AGENT_NAME_STEM_SOURCE})[\\p{L}\\p{N}_]*`, "giu");

function words(text: string): string[] {
  return text
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .match(/\+1|[\p{L}\p{N}]+/gu) ?? [];
}

// Phrases go through the same normalisation as the message, «всё» and «все» included.
const PHRASE_KEYS = new Set(SMALL_TALK_PHRASES.map((phrase) => words(phrase).join(" ")));
const LONGEST_PHRASE = Math.max(...SMALL_TALK_PHRASES.map((phrase) => words(phrase).length));

/**
 * The text as `prepareMemoryQuery` returns it: a leading address to the assistant already removed.
 * An address it kept — no comma after the name, or a mention mid-message — is skipped here.
 */
export function isSmallTalkMessage(prepared: string): boolean {
  const withoutMentions = prepared.replace(AGENT_MENTION_PATTERN, " ");
  const all = words(withoutMentions);
  const tokens = all.filter((token) => !AGENT_NAME_ADDRESS_PATTERN.test(token));
  // «Осинара?» or a bare mention asks the assistant to answer and memory nothing; a message with no
  // words at all («!!!») is not a call and keeps its search.
  if (tokens.length === 0) return withoutMentions !== prepared || all.length > 0;
  if (tokens.length > MAX_SMALL_TALK_WORDS) return false;
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
