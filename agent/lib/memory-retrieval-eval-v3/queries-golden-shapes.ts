/**
 * V3 queries in the shapes the real-memory golden set found failing.
 *
 * Export:
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_GOLDEN_SHAPES_V3`: small talk, other words for the same thing,
 *   questions about a day or a period, and facts that changed.
 *
 * On 153 real turns the automatic selection never once stayed empty when nothing was needed, and
 * most of those turns were a greeting or a reaction; needed records were missed when the question
 * named the thing by slang or transliteration, or asked about a day rather than a topic. The
 * shapes are copied from there; every word of content is invented.
 */
import type { MemoryRetrievalEvalQueryV3 } from "./types.js";

export const MEMORY_RETRIEVAL_EVAL_QUERIES_GOLDEN_SHAPES_V3: readonly MemoryRetrievalEvalQueryV3[] = [
  // Болтовня: памяти не нужно ничего, любая выдача — шум в контексте модели.
  { category: "small_talk", expectedKeys: [], key: "small-talk-hello", text: "привет" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-ping", text: "куку" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-thanks", text: "спасибо, понял" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-bot-there", text: "Осинара, ты тут?" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-laugh", text: "ахахах" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-morning", text: "доброе утро!" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-how-are-you", text: "как дела?" },
  { category: "small_talk", expectedKeys: [], key: "small-talk-just-test",
    text: "просто проверка связи, ничего не надо" },

  // Другое слово для той же вещи: в записи одно, в вопросе сленг, сокращение или транслитерация.
  { category: "alias_wording", expectedKeys: ["backup-target"], key: "alias-backup",
    text: "Куда уходит бэкап по ночам?" },
  { category: "alias_wording", expectedKeys: ["work-laptop"], key: "alias-computer",
    text: "Какой комп выдали на работе?" },
  { category: "alias_wording", expectedKeys: ["ladoga-repository"], key: "alias-repo",
    text: "Скинь репу Ладоги" },
  { category: "alias_wording", expectedKeys: ["internet-plan"], key: "alias-internet",
    text: "Сколько стоит инет?" },
  { category: "alias_wording", expectedKeys: ["alena-birthday"], key: "alias-birthday",
    text: "Когда ДР у Алёны?" },
  { category: "alias_wording", expectedKeys: ["car-service"], key: "alias-car",
    text: "Кто чинит тачку?" },
  { category: "alias_wording", expectedKeys: ["guest-wifi"], key: "alias-wifi",
    text: "Как гостям подключиться к вайфаю?" },
  { category: "alias_wording", expectedKeys: ["ladoga-standup"], key: "alias-standup",
    text: "Во сколько дейли у Ладоги?" },

  // День или период: дата есть только у события, в тексте записи её нет.
  { category: "date_question", expectedKeys: ["physics-exam"], key: "date-yesterday",
    text: "Что было вчера?" },
  { category: "date_question", expectedKeys: ["fedor-tonometer"], key: "date-day-before",
    text: "Осинара, напомни, что мы делали позавчера" },
  // Ровно неделю назад, а не «на прошлой неделе»: граница календарной недели зависела бы от дня прогона.
  { category: "date_question", expectedKeys: ["kitchen-faucet"], key: "date-week-ago",
    text: "Что у нас случилось неделю назад?" },
  { category: "date_question", expectedKeys: ["valdai-trip", "valdai-fishing"], key: "date-month",
    text: "Что мы делали в июне 2025 года?" },
  { category: "date_question", expectedKeys: ["boiler-repair"], key: "date-exact-day",
    text: "Что произошло 3 марта?" },

  // Факт обновлялся: прежняя версия хранится заменённой, ответить должна текущая.
  { category: "updated_fact", expectedKeys: ["internet-plan"], key: "updated-internet",
    text: "Какой у нас тариф на интернет?" },
  { category: "updated_fact", expectedKeys: ["car-service"], key: "updated-car-service",
    text: "В каком сервисе обслуживаем машину?" },
  { category: "updated_fact", expectedKeys: ["petr-shoe-size"], key: "updated-shoe-size",
    text: "Какой размер обуви у Петра сейчас?" },
  { category: "updated_fact", expectedKeys: ["oleg-reminder-time"], key: "updated-reminders",
    text: "Когда Олегу присылать напоминания?" },
];
