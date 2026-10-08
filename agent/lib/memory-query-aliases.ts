/**
 * Slang, abbreviations and transliteration the search should also read in their plain form.
 *
 * Exports:
 * - `MEMORY_QUERY_ALIASES`: each everyday spelling with the words a record would use instead.
 * - `withQueryAliases`: the search text with those words added for every alias it contains.
 *
 * A record says «машина», «репозиторий», «GitHub»; people ask about «тачку», «репу», «гитхаб».
 * The word branches never match the two, and the meaning branch often does, but weakly, so the
 * record loses its place to records that share more words (#345). The plain word is added to the
 * search text — never replacing what the person wrote — and both kinds of search read it.
 *
 * Only spellings with one meaning in a family or a work chat are listed. «Железо» is a server, a
 * laptop or a metal; «репа» could be a turnip, and is listed anyway because nobody keeps a record
 * about a turnip's location. A word with no single plain form stays out: a wrong expansion pulls
 * in other records, which is worse than a missed one. Aliases that belong to one family — what
 * they call their car or their dacha — are not here; that would be per-subject data.
 */

interface QueryAlias {
  /** Whole-word forms, lower case; matched case-sensitively when `caseSensitive`. */
  forms: RegExp;
  plain: string;
}

const word = (forms: string, flags = "iu") => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${forms})(?=$|[^\\p{L}\\p{N}])`, flags);

export const MEMORY_QUERY_ALIASES: readonly QueryAlias[] = [
  { forms: word("тачк[аеиуо]|тачкой|тачками|тачек"), plain: "машина автомобиль" },
  { forms: word("комп|компа|компу|компом|компе|компы|компов"), plain: "компьютер" },
  { forms: word("ноут|ноута|ноуту|ноутом|ноуте|ноуты"), plain: "ноутбук" },
  { forms: word("инет|инета|инету|инетом|инете"), plain: "интернет" },
  { forms: word("вайфа[йяюе]|вай-фа[йяюе]|вайфаем"), plain: "Wi-Fi" },
  { forms: word("реп[аеиуы]|репой|репку"), plain: "репозиторий" },
  // «ДР» only in capitals: «и др.» is «и другие».
  { forms: word("ДР", "u"), plain: "день рождения" },
  { forms: word("днюх[аеиу]|днюхой"), plain: "день рождения" },
  { forms: word("дейли|дэйли"), plain: "ежедневный созвон" },
  { forms: word("бэкап|бэкапа|бэкапу|бэкапом|бэкапе|бэкапы|бекап|бекапа|бекапы"), plain: "резервная копия" },
  { forms: word("гитхаб|гитхаба|гитхабу|гитхабом|гитхабе"), plain: "GitHub" },
  { forms: word("гитлаб|гитлаба|гитлабе"), plain: "GitLab" },
  { forms: word("нжинкс|нжинкса|нжинксе|энжинкс"), plain: "nginx" },
  { forms: word("гардрейл[ыаов]*|гардрейлами"), plain: "guardrails" },
  { forms: word("докер|докера|докеру|докере|докером"), plain: "Docker" },
  { forms: word("кубер|кубера|кубере|кубернетес"), plain: "Kubernetes" },
  { forms: word("телег[аеиу]|телегой"), plain: "Telegram" },
];

export function withQueryAliases(text: string): string {
  const lower = text.toLocaleLowerCase("ru-RU");
  const added = [...new Set(MEMORY_QUERY_ALIASES
    .filter((alias) => alias.forms.test(text))
    .map((alias) => alias.plain))]
    // A plain form the text already holds — the person wrote both, or this ran twice — adds nothing.
    .filter((plain) => !lower.includes(plain.toLocaleLowerCase("ru-RU")));
  return added.length === 0 ? text : `${text} ${added.join(" ")}`;
}
