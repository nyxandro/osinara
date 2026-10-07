/**
 * Questions asked in the measured external chat.
 *
 * Export:
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES`: every question with the records it is expected to
 *   surface; an empty list means the selection must stay empty.
 *
 * The shapes follow the live group in the real-memory golden set, where 127 of 153 turns were
 * group turns: most of them were reactions and jokes that needed nothing, the rest asked about one
 * person, a tool several people use, the bot itself, or a link someone had brought. `expectedKeys`
 * is satisfied by any one of its entries, except where full coverage is measured separately.
 */
import type { MemoryRetrievalEvalGroupQuery } from "./types.js";

export const MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES: readonly MemoryRetrievalEvalGroupQuery[] = [
  // Про конкретного участника: рядом лежат записи соседей на ту же тему.
  { category: "participant_fact", expectedKeys: ["vika-uley"], key: "person-vika-uley",
    text: "Осинара, что Вика говорила про Улей?" },
  { category: "participant_fact", expectedKeys: ["timur-city"], key: "person-timur-city",
    text: "Где живёт Тимур?" },
  { category: "participant_fact", expectedKeys: ["timur-voice-agent"], key: "person-timur-voice",
    text: "на чём Тимур делает голосового агента?" },
  { category: "participant_fact", expectedKeys: ["roman-uley"], key: "person-roman-runtime",
    text: "Осинара, чем Роман пользуется для агентов?" },
  { category: "participant_fact", expectedKeys: ["vika-job"], key: "person-vika-job",
    text: "кем работает Вика?" },
  { category: "participant_fact", expectedKeys: ["nina-memory-opinion", "nina-vector-review"],
    key: "person-nina-vectors", text: "что Нина думает про векторные базы?" },
  { category: "participant_fact", expectedKeys: ["nina-moved"], key: "person-nina-city",
    text: "Куда переехала Нина?" },
  { category: "participant_fact", expectedKeys: ["artem-work-memory"], key: "person-artem-memory",
    text: "Чего Артём хочет от памяти рабочего агента?" },

  // Про этого участника такого нет, про соседа — есть: уверенный чужой ответ хуже молчания.
  { category: "participant_near_miss", expectedKeys: [], key: "near-miss-nina-staya",
    text: "что Нина говорила про Стаю?" },
  { category: "participant_near_miss", expectedKeys: [], key: "near-miss-roman-city",
    text: "Где живёт Роман?" },
  { category: "participant_near_miss", expectedKeys: [], key: "near-miss-timur-talk",
    text: "С каким докладом выступал Тимур?" },
  { category: "participant_near_miss", expectedKeys: [], key: "near-miss-seva-uley",
    text: "Сева уже пользуется Ульем?" },
  { category: "participant_near_miss", expectedKeys: [], key: "near-miss-vika-game",
    text: "Какую настолку советует Вика?" },

  // Тема, по которой писали несколько человек: полное покрытие считается отдельно.
  { category: "topic_any", expectedKeys: ["vika-uley", "roman-uley", "gleb-parallel-agents"],
    key: "topic-uley", text: "кто тут пользуется Ульем?" },
  { category: "topic_any", expectedKeys: ["timur-staya", "gleb-parallel-agents"], key: "topic-staya",
    text: "кто что думает про Стаю?" },
  { category: "topic_any", expectedKeys: ["artem-nginx", "seva-assistant"], key: "topic-sosna",
    text: "кто пробовал Сосну Flash?" },
  { category: "topic_any", expectedKeys: ["nina-research", "nina-memory-opinion", "nina-vector-review"],
    key: "topic-agent-memory", text: "кто у нас разбирается в памяти агентов?" },

  // Бот о себе.
  { category: "bot_persona", expectedKeys: ["bot-avatar"], key: "bot-looks",
    text: "Осинара, как ты выглядишь?" },
  { category: "bot_persona", expectedKeys: ["bot-voice"], key: "bot-voice-origin",
    text: "откуда у тебя такой голос?" },
  { category: "bot_persona", expectedKeys: ["bot-shell-policy"], key: "bot-shell",
    text: "Осинара, тебе можно запускать команды на сервере?" },
  { category: "bot_persona", expectedKeys: ["gleb-builds-bot"], key: "bot-author",
    text: "кто тебя сделал?" },

  // Ссылка, которую уже приносили в чат.
  { category: "link_request", expectedKeys: ["roman-uley-guide"], key: "link-uley-guide",
    text: "кинь инструкцию Романа по Улью" },
  { category: "link_request", expectedKeys: ["staya-docs"], key: "link-staya-docs",
    text: "где почитать доку по Стае?" },
  { category: "link_request", expectedKeys: ["nina-vector-review"], key: "link-nina-review",
    text: "скинь разбор Нины про векторные базы" },
  { category: "link_request", expectedKeys: ["artem-fork"], key: "link-artem-fork",
    text: "где лежит форк Артёма?" },

  // Другое слово для той же вещи — то, на чём живой чат терял нужные записи.
  { category: "alias_wording", expectedKeys: ["bot-github"], key: "alias-github",
    text: "Осинара, напомни свой гитхаб" },
  { category: "alias_wording", expectedKeys: ["bot-hosting"], key: "alias-hardware",
    text: "Осинара, ты на каком железе крутишься?" },
  { category: "alias_wording", expectedKeys: ["bot-guardrails"], key: "alias-guardrails",
    text: "какие у тебя гардрейлы?" },
  { category: "alias_wording", expectedKeys: ["artem-nginx"], key: "alias-nginx",
    text: "на чём Артём кеширует нжинкс?" },

  // Болтовня в общем потоке.
  { category: "small_talk", expectedKeys: [], key: "chat-laugh", text: "ахаха" },
  { category: "small_talk", expectedKeys: [], key: "chat-praise", text: "Осинара, умница" },
  { category: "small_talk", expectedKeys: [], key: "chat-tipsy", text: "ты подшофе?" },
  { category: "small_talk", expectedKeys: [], key: "chat-meme", text: "а мем так-то смешной" },
  { category: "small_talk", expectedKeys: [], key: "chat-plus-one", text: "+1" },
  { category: "small_talk", expectedKeys: [], key: "chat-bedtime", text: "ну всё, я спать" },
  { category: "small_talk", expectedKeys: [], key: "chat-open-door",
    text: "заходи кто хочешь, получается" },
  { category: "small_talk", expectedKeys: [], key: "chat-say-something",
    text: "Осинара, просто ответь что-нибудь" },
];
