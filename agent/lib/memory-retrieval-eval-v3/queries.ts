/**
 * V3 queries: the shapes a person actually types and speaks.
 *
 * Export:
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V3`: every query with the records it is expected to surface.
 *
 * V1 and V2 asked short clean questions such as «Где репозиторий Orca?». Live messages do not look
 * like that: they open with the bot's name, carry emoji and Markdown, arrive from voice as one
 * unpunctuated line, hold two or three unrelated topics at once, and run past four hundred
 * characters. Those shapes are the whole point of this set, because that is where a branch that
 * requires every word of the question quietly stops firing.
 *
 * `expectedKeys` is satisfied by any one of its entries: several records can be a fair answer to
 * one question, and the measurement is recall, not ranking of equals.
 */
import type { MemoryRetrievalEvalQueryV3 } from "./types.js";

export const MEMORY_RETRIEVAL_EVAL_QUERIES_V3: readonly MemoryRetrievalEvalQueryV3[] = [
  // Точные токены: числа, коды, тикеры, серийники. Ради них живёт ветка simple.
  { category: "exact", expectedKeys: ["intercom-code"], key: "exact-intercom", text: "4271" },
  { category: "exact", expectedKeys: ["cold-water-meter"], key: "exact-meter",
    text: "ХВ-118420" },
  { category: "exact", expectedKeys: ["portfolio-tickers"], key: "exact-ticker", text: "LDGA" },
  { category: "exact", expectedKeys: ["work-laptop"], key: "exact-serial",
    text: "VK14-300277" },
  { category: "exact", expectedKeys: ["petr-bicycle"], key: "exact-frame-number",
    text: "PB-77412" },
  { category: "exact", expectedKeys: ["broker-account"], key: "exact-contract",
    text: "77-041289" },

  // Словоформы: вопрос задан в другом падеже и времени, чем запись.
  { category: "russian_morphology", expectedKeys: ["ksenia-visits", "ksenia-may-visit", "new-year"],
    key: "morphology-visits", text: "Когда приезжала Ксения?" },
  { category: "russian_morphology", expectedKeys: ["currant-planting"],
    key: "morphology-currant", text: "Смородину куда посадили?" },
  { category: "russian_morphology", expectedKeys: ["fence-painting"],
    key: "morphology-fence", text: "Кто красил забор на даче?" },
  { category: "russian_morphology", expectedKeys: ["petr-braces"],
    key: "morphology-braces", text: "Кому ставили брекеты?" },
  { category: "russian_morphology", expectedKeys: ["car-accident"],
    key: "morphology-insurance", text: "Что чинили по страховке?" },
  { category: "russian_morphology", expectedKeys: ["lawnmower-fuel"],
    key: "morphology-mower", text: "Чем заправляют газонокосилку?" },

  // Пересказ: общих слов с записью почти нет, работать должна смысловая ветка.
  { category: "semantic_paraphrase", expectedKeys: ["spare-key-flat"],
    key: "paraphrase-locked-out", text: "Как попасть домой, если ключи остались внутри?" },
  { category: "semantic_paraphrase", expectedKeys: ["petr-lactose", "household-milk"],
    key: "paraphrase-dairy", text: "У кого из детей плохо с молочными продуктами?" },
  { category: "semantic_paraphrase", expectedKeys: ["marina-nut-allergy"],
    key: "paraphrase-nuts", text: "Кому нельзя орехи?" },
  { category: "semantic_paraphrase", expectedKeys: ["ladoga-freeze", "ladoga-deploy"],
    key: "paraphrase-friday-freeze",
    text: "Можно ли выкатывать изменения в конце рабочей недели?" },
  { category: "semantic_paraphrase", expectedKeys: ["oleg-morning-run"],
    key: "paraphrase-early-riser", text: "Кто в семье поднимается раньше всех?" },
  { category: "semantic_paraphrase", expectedKeys: ["backup-target"],
    key: "paraphrase-cross-language",
    text: "Where is the nightly backup of the work files stored?" },

  // Смешанный русско-английский текст: обычная форма рабочего вопроса.
  { category: "mixed_language", expectedKeys: ["ladoga-deploy"], key: "mixed-deploy",
    text: "Когда deploy проекта Ладога?" },
  { category: "mixed_language", expectedKeys: ["vpn-profile"], key: "mixed-vpn",
    text: "Какой VPN profile поднимать для офиса?" },
  { category: "mixed_language", expectedKeys: ["ladoga-database"], key: "mixed-database",
    text: "Какая база и extension в проекте Ладога?" },
  { category: "mixed_language", expectedKeys: ["signed-commits", "signing-key"],
    key: "mixed-commits", text: "Нужно ли signed commits в Ладоге и где лежит ключ?" },

  // Опечатки, в том числе в именах собственных: самая частая причина промаха вживую.
  { category: "typo", expectedKeys: ["spare-key-dacha"], key: "typo-spare-key",
    text: "Где лежит запсаной ключ от дачи?" },
  { category: "typo", expectedKeys: ["intercom-code"], key: "typo-intercom",
    text: "Какой там код дмофона?" },
  { category: "typo", expectedKeys: ["trip-suzdal", "trip-suzdal-hat", "trip-suzdal-road"],
    key: "typo-place-name", text: "Что было в Суздле?" },
  { category: "typo", expectedKeys: ["marina-nut-allergy"], key: "typo-person-name",
    text: "На что аллергия у Мариы?" },
  { category: "typo", expectedKeys: ["alena-teacher-phone"], key: "typo-teacher",
    text: "Телефон класного руководителя" },

  // «е» в запросе против «ё» в записи: точная ветка считает их разными словами.
  { category: "yo_spelling", expectedKeys: ["petr-tea"], key: "yo-petr",
    text: "Что пьет Петр по утрам?" },
  { category: "yo_spelling", expectedKeys: ["fedor-birthday"], key: "yo-fedor-birthday",
    text: "Когда день рождения Федора?" },
  { category: "yo_spelling", expectedKeys: ["alena-birthday"], key: "yo-alena-birthday",
    text: "Когда у Алены день рождения?" },
  { category: "yo_spelling", expectedKeys: ["fedor-relation"], key: "yo-fedor-age",
    text: "Сколько лет Федору?" },

  // Обращение к боту в начале: лишние слова, которых нет ни в одной записи.
  { category: "bot_address", expectedKeys: ["intercom-code"], key: "address-intercom",
    text: "Осинара, напомни код от домофона" },
  { category: "bot_address", expectedKeys: ["internet-plan"], key: "address-internet",
    text: "Осинара привет, какой у нас тариф на интернет дома?" },
  { category: "bot_address", expectedKeys: ["petr-birthday"], key: "address-birthday",
    text: "Слушай, Осинара, когда у Петра день рождения?" },
  { category: "bot_address", expectedKeys: ["screen-time-rule"], key: "address-screen-time",
    text: "Осинара, что мы решили насчёт экранного времени детей?" },
  { category: "bot_address", expectedKeys: ["first-aid-kit"], key: "address-first-aid",
    text: "Осинара скажи пожалуйста где у нас лежит аптечка" },

  // Эмодзи и разметка внутри вопроса.
  { category: "emoji_markup", expectedKeys: ["alena-birthday"], key: "emoji-birthday",
    text: "🎂 когда днюха у Алёны?" },
  { category: "emoji_markup", expectedKeys: ["gate-code"], key: "markup-gate",
    text: "**Важно**: какой код от калитки на даче?" },
  { category: "emoji_markup", expectedKeys: ["petr-bicycle"], key: "emoji-bicycle",
    text: "Напомни 🚲 номер рамы велосипеда Петра" },

  // Расшифровка голоса: без знаков препинания и заглавных, с вводными словами.
  { category: "voice_transcript", expectedKeys: ["intercom-code"], key: "voice-intercom",
    text: "слушай а какой там код от домофона в подъезде я опять забыл" },
  { category: "voice_transcript", expectedKeys: ["winter-tires"], key: "voice-tires",
    text: "напомни пожалуйста что там с зимней резиной когда мы её меняем" },
  { category: "voice_transcript", expectedKeys: ["alena-citrus-allergy"], key: "voice-allergy",
    text: "у алёны аллергия на что там было напомни а то я забыл совсем" },
  { category: "voice_transcript", expectedKeys: ["ladoga-standup"], key: "voice-standup",
    text: "во сколько там совещание в понедельник у меня на работе" },
  { category: "voice_transcript", expectedKeys: ["sea-trip-postponed", "sea-trip-saving"],
    key: "voice-sea-trip", text: "что мы там решили в итоге про поездку на море" },

  // Длинный запрос: больше четырёхсот символов, то есть несколько кусков эмбеддинга.
  { category: "long_query", expectedKeys: ["spare-key-dacha", "dacha-boiler", "lawnmower-fuel"],
    key: "long-dacha-trip",
    text: "Собираемся в субботу на дачу, выезжаем рано утром, и я хочу заранее всё вспомнить, " +
      "потому что в прошлый раз половину забыли и пришлось возвращаться. Надо понять, где " +
      "сейчас лежит запасной ключ, потому что основной я куда-то задевал, и заодно вспомнить, " +
      "за сколько времени до приезда включать воду, чтобы она успела нагреться к вечеру. Ещё " +
      "надо не забыть про газонокосилку и про то, чем мы её в прошлый раз заправляли." },
  { category: "long_query",
    expectedKeys: ["alena-school", "pool-subscription", "alena-swimming", "alena-gymnastics"],
    key: "long-school-year",
    text: "Скоро учебный год, и я пытаюсь собрать в голове всё, что связано с младшей: в какой " +
      "она класс переходит и в какой школе это вообще происходит, потому что я всё время путаю " +
      "номер. Плюс у неё был бассейн, и я не помню, оплачен ли абонемент и до какого месяца, а " +
      "ещё сколько раз в неделю она туда ходит, чтобы не наложить это на другие занятия, " +
      "которые у неё стоят в середине недели, и я про них тоже всё время забываю." },
  { category: "long_query", expectedKeys: ["ladoga-deploy", "ladoga-freeze", "merge-policy"],
    key: "long-release-window",
    text: "Хочу спланировать выкатку на следующую неделю и заранее понять ограничения, чтобы " +
      "не устраивать спешку в последний момент. Напомни, в какой день недели мы вообще " +
      "разворачиваем проект и на каком стенде это происходит, и какое у нас было правило про " +
      "вечер пятницы, потому что я помню, что мы о чём-то договаривались, но детали вылетели. " +
      "И ещё, что именно должно быть зелёным, прежде чем сливать в основную ветку." },
  { category: "long_query", expectedKeys: ["fedor-pressure-medicine", "fedor-followup"],
    key: "long-grandfather-health",
    text: "Завтра еду к отцу и хочу заранее всё уточнить, потому что каждый раз что-нибудь " +
      "упускаю и потом перезваниваю. Он после больницы принимает лекарство, и я не помню, " +
      "сколько раз в день его нужно пить и в какое время, утром или вечером, или и так и так. " +
      "А ещё ему назначали что-то измерять регулярно после выписки, и я хочу проверить, " +
      "делает ли он это вообще, как часто это нужно делать и записывает ли он показания." },
  { category: "long_query", expectedKeys: ["petr-bicycle-request", "petr-bicycle"],
    key: "long-bicycle",
    text: "Старший давно просит велосипед получше, и я хочу вернуться к этому разговору, но " +
      "сначала вспомнить, о чём мы вообще договорились и на какой месяц отложили решение. " +
      "Заодно нужно понять, что у него сейчас за велосипед: какого он цвета, есть ли на нём " +
      "багажник и какой у него номер рамы, потому что если продавать, то это спросят в первую " +
      "очередь, а искать документы по всей квартире совершенно не хочется." },

  // Несколько независимых тем в одном сообщении: ни одну терять нельзя.
  { category: "multi_topic", expectedKeys: ["cat-food", "gate-code"], key: "multi-cat-gate",
    text: "Надо заказать корм коту, и заодно напомни код от калитки на даче." },
  { category: "multi_topic", expectedKeys: ["meter-deadline", "pool-subscription"],
    key: "multi-meters-pool",
    text: "Не забыть сдать показания счётчиков и проверить абонемент в бассейн." },
  { category: "multi_topic", expectedKeys: ["petr-table-tennis", "oleg-vacation"],
    key: "multi-tennis-vacation",
    text: "Когда у старшего тренировка и на какие числа у меня согласован отпуск?" },
  { category: "multi_topic", expectedKeys: ["oncall-next", "winter-tires"],
    key: "multi-oncall-tires",
    text: "Проверь, когда у меня ближайшее дежурство, и когда мы меняем резину." },
  { category: "multi_topic", expectedKeys: ["petr-braces", "alena-parent-meeting"],
    key: "multi-braces-meeting",
    text: "Что там с брекетами у старшего и когда собрание у младшей?" },

  // Ответа нет, но рядом есть почти такая же запись про другой объект или другого человека.
  // Именно здесь живой ложноположительный ответ выглядит убедительно: назвать код от домофона
  // в ответ на вопрос про гараж хуже, чем честно промолчать.
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-garage-code",
    text: "Какой код от гаража?" },
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-ladozhanka",
    text: "Где репозиторий проекта Ладожанка?" },
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-ksenia-birthday",
    text: "Когда день рождения Ксении?" },
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-fedor-shoe-size",
    text: "Какой размер обуви у Фёдора?" },
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-marina-allergy-medicine",
    text: "Какое лекарство принимает Марина от давления?" },
  { category: "near_miss_negative", expectedKeys: [], key: "near-miss-third-water-meter",
    text: "Номер счётчика электричества в квартире?" },

  // Ответа в корпусе нет и вопрос вообще не про память: правильная выдача — пустая.
  { category: "negative", expectedKeys: [], key: "negative-weather",
    text: "Какая завтра погода в Лиссабоне?" },
  { category: "negative", expectedKeys: [], key: "negative-hockey",
    text: "Кто выиграл чемпионат мира по хоккею?" },
  { category: "negative", expectedKeys: [], key: "negative-train",
    text: "Сколько стоит билет на поезд до Владивостока?" },
  { category: "negative", expectedKeys: [], key: "negative-recipe",
    text: "Как приготовить ризотто с белыми грибами?" },
  { category: "negative", expectedKeys: [], key: "negative-history",
    text: "Когда изобрели паровой двигатель?" },
  { category: "negative", expectedKeys: [], key: "negative-currency",
    text: "Какой сегодня курс доллара?" },
] as const;
