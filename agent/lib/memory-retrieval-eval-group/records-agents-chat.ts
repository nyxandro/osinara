/**
 * Group corpus, part one: the external chat the questions are asked in.
 *
 * Export:
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_AGENTS_CHAT`: participants, their tools and opinions, the
 *   links they brought, and what the chat knows about the bot itself.
 *
 * Modelled on the shape of the one live external group in the real-memory golden set: several
 * people discuss the same few tools, so most questions about one person have a neighbour about
 * another person on the same topic; and the bot is asked about itself. Every name, handle, tool,
 * and URL is invented.
 */
import type { MemoryRetrievalEvalGroupRecord } from "./types.js";

const chat = (record: Omit<MemoryRetrievalEvalGroupRecord, "area">): MemoryRetrievalEvalGroupRecord =>
  ({ ...record, area: "agents_chat" });

const GLEB = "Глеб Арсеньев (gleb_ars)";
const VIKA = "Вика Лунина (vlunina)";
const TIMUR = "Тимур Хасанов (timkhas)";
const ROMAN = "Роман Ершов (rershov)";
const NINA = "Нина Дорн (ninadorn)";
const ARTEM = "Артём Белов (abelov)";
const SEVA = "Сева Крайнов (sevakr)";
const BOT = "Осинара";

export const MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_AGENTS_CHAT: readonly MemoryRetrievalEvalGroupRecord[] = [
  chat({ content: "Глеб Арсеньев — разработчик Осинары: пишет её на собственном ядре и выкатывает обновления несколько раз в день.",
    key: "gleb-builds-bot", kind: "profile", subjectLabel: GLEB, updatedAt: "2026-09-20" }),
  chat({ content: "Глеб запускает параллельно до десяти агентов через Стаю и Улей, и тридцати двух гигабайт памяти ноутбука на это не хватает.",
    key: "gleb-parallel-agents", kind: "fact", subjectLabel: GLEB, updatedAt: "2026-09-21" }),
  chat({ content: "Осинара работает на арендованном сервере в Финляндии, модель Кедр-27B подключена через хаб Нейроузел.",
    key: "bot-hosting", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-22" }),
  chat({ content: "Глеб собрал для Осинары guardrails: запрет разрушающих команд и обёртку для недоверенного текста.",
    key: "bot-guardrails", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-23" }),
  chat({ content: "Глеб при установке любого софта первым делом выключает в настройках всё лишнее.",
    key: "gleb-settings-habit", kind: "preference", subjectLabel: GLEB, updatedAt: "2026-09-24" }),

  chat({ content: "Вика Лунина — продакт в финтехе: сама не программирует, собирает прототипы через агентов.",
    key: "vika-job", kind: "profile", subjectLabel: VIKA, updatedAt: "2026-09-20" }),
  chat({ content: "Вика пересела на Улей, а старый редактор оставила только для слияния веток.",
    key: "vika-uley", kind: "fact", subjectLabel: VIKA, updatedAt: "2026-09-25" }),
  chat({ content: "Вика советует трекер Причал: задачи живут в markdown-файлах рядом с кодом.",
    key: "vika-prichal", kind: "fact", subjectLabel: VIKA, updatedAt: "2026-09-26" }),
  chat({ content: "Вика выступала на митапе с докладом про агентов для нетехнических команд.",
    key: "vika-meetup-talk", kind: "episode", subjectLabel: VIKA, updatedAt: "2026-10-02" }),

  chat({ content: "Тимур Хасанов живёт в Казани и работает бэкендером в логистической компании.",
    key: "timur-city", kind: "profile", subjectLabel: TIMUR, updatedAt: "2026-09-20" }),
  chat({ content: "Тимур считает Стаю лучшей для параллельных агентов, но ставить её на сервер больно.",
    key: "timur-staya", kind: "fact", subjectLabel: TIMUR, updatedAt: "2026-09-27" }),
  chat({ content: "Тимур строит голосового агента на Кедр-27B у себя в контуре: данные нельзя выносить наружу.",
    key: "timur-voice-agent", kind: "fact", subjectLabel: TIMUR, updatedAt: "2026-09-28" }),
  chat({ content: "Тимур не любит, когда агент сам коммитит без спроса.",
    key: "timur-no-auto-commit", kind: "preference", subjectLabel: TIMUR, updatedAt: "2026-09-28" }),

  chat({ content: "Роман Ершов ездит на работу на моноколесе, даже зимой.",
    key: "roman-unicycle", kind: "profile", subjectLabel: ROMAN, updatedAt: "2026-09-20" }),
  chat({ content: "Роман пользуется Ульем как основным рантаймом агентов и подключается к нему с телефона через туннель.",
    key: "roman-uley", kind: "fact", subjectLabel: ROMAN, updatedAt: "2026-09-29" }),
  chat({ content: "Роман поделился инструкцией по настройке Улья: https://notes.example/rershov/uley-setup",
    key: "roman-uley-guide", kind: "fact", subjectLabel: ROMAN, updatedAt: "2026-09-29" }),
  chat({ content: "Роман советует настольную игру Колонизаторы Луны, но для неё нужно пять человек.",
    key: "roman-board-game", kind: "fact", subjectLabel: ROMAN, updatedAt: "2026-09-30" }),

  chat({ content: "Нина Дорн — исследователь, изучает память агентов и ведёт канал про RAG.",
    key: "nina-research", kind: "profile", subjectLabel: NINA, updatedAt: "2026-09-20" }),
  chat({ content: "Нина считает, что для памяти агента разметка записей по людям важнее, чем выбор векторной базы.",
    key: "nina-memory-opinion", kind: "fact", subjectLabel: NINA, updatedAt: "2026-09-30" }),
  chat({ content: "Нина опубликовала разбор векторных баз для агентов: https://notes.example/ninadorn/vector-db-review",
    key: "nina-vector-review", kind: "fact", subjectLabel: NINA, updatedAt: "2026-10-01" }),
  chat({ content: "Нина переехала из Москвы в Тбилиси.",
    key: "nina-moved", kind: "episode", subjectLabel: NINA, updatedAt: "2026-09-15" }),

  chat({ content: "Артём Белов — девопс, держит несколько VPS и мониторинг на них.",
    key: "artem-job", kind: "profile", subjectLabel: ARTEM, updatedAt: "2026-09-20" }),
  chat({ content: "Артём настраивает кеширование nginx агентами на модели Сосна Flash и доволен скоростью.",
    key: "artem-nginx", kind: "fact", subjectLabel: ARTEM, updatedAt: "2026-10-01" }),
  chat({ content: "Артём выложил форк Осинары: https://code.example/abelov/osinara-fork",
    key: "artem-fork", kind: "fact", subjectLabel: ARTEM, updatedAt: "2026-10-02" }),
  chat({ content: "Артём хочет, чтобы рабочий агент не помнил ничего между проектами, а личный — наоборот, всё.",
    key: "artem-work-memory", kind: "preference", subjectLabel: ARTEM, updatedAt: "2026-10-02" }),

  chat({ content: "Сева Крайнов — студент второго курса прикладной математики.",
    key: "seva-study", kind: "profile", subjectLabel: SEVA, updatedAt: "2026-09-20" }),
  chat({ content: "Сева собирается сделать личного ассистента для отца-предпринимателя на модели Сосна Flash.",
    key: "seva-assistant", kind: "fact", subjectLabel: SEVA, updatedAt: "2026-10-03" }),
  chat({ content: "Сева спрашивал, как подавать контекст модели, чтобы она общалась живее и человечнее.",
    key: "seva-lively-context", kind: "fact", subjectLabel: SEVA, updatedAt: "2026-10-03" }),

  chat({ content: "Аватар Осинары — золотистый колобок с румянцем и улыбкой; так её рисуют, когда чат просит.",
    key: "bot-avatar", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-25" }),
  chat({ content: "Голос Осинары озвучивается через сервис Эхо; хриплый голос выбрали нарочно, чату он нравится.",
    key: "bot-voice", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-26" }),
  chat({ content: "Код Осинары открыт на GitHub: https://github.example/gleb-ars/osinara",
    key: "bot-github", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-27" }),
  chat({ content: "В публичных чатах Осинаре не дают запускать команды на сервере, в личных и семейных — дают.",
    key: "bot-shell-policy", kind: "fact", subjectLabel: BOT, updatedAt: "2026-09-28" }),

  chat({ content: "Документация Стаи опубликована на https://docs.example/staya",
    key: "staya-docs", kind: "fact", subjectLabel: "Стая", updatedAt: "2026-09-27" }),
  chat({ content: "Документация Причала лежит в репозитории проекта, в каталоге docs.",
    key: "prichal-docs", kind: "fact", subjectLabel: "Причал", updatedAt: "2026-09-26" }),
  chat({ content: "Правило чата: ссылки на платные курсы без спроса не присылать.",
    key: "chat-rule-courses", kind: "fact", subjectLabel: "Агентная кухня", updatedAt: "2026-09-20" }),
  chat({ content: "Раз в месяц чат собирает топ самых сильных мыслей участников.",
    key: "chat-monthly-top", kind: "fact", subjectLabel: "Агентная кухня", updatedAt: "2026-09-21" }),
  chat({ content: "Чат спорил, нужен ли агентам RAG или хватает поиска по файлам через grep.",
    key: "chat-rag-debate", kind: "episode", subjectLabel: "Агентная кухня", updatedAt: "2026-10-04" }),
];
