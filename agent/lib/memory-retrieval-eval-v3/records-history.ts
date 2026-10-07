/**
 * V3 corpus, part five: dated events and facts that changed.
 *
 * Export:
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_HISTORY_V3`: events whose date lives only in the date field,
 *   and earlier versions of facts the corpus already holds.
 *
 * Both come from the real-memory golden set. People ask «что было вчера» or «что мы делали в
 * июне», and the record of that day says what happened, not when: the date is the event's own
 * field. And facts change — a tariff, a shoe size — so the memory holds the old version as
 * superseded next to the current one, and only the current one may ever be offered.
 */
import type { MemoryRetrievalEvalRecordV3 } from "./types.js";

export const MEMORY_RETRIEVAL_EVAL_RECORDS_HISTORY_V3: readonly MemoryRetrievalEvalRecordV3[] = [
  { content: "Ездили всей семьёй на Валдай, жили в деревянном доме у озера.",
    key: "valdai-trip", occurredOn: "2025-06-14", subjectLabel: "Семья Соколовых",
    kind: "episode", scope: "family", updatedAt: "2025-06-16" },
  { content: "Пётр поймал на озере щуку на два килограмма, её отпустили обратно.",
    key: "valdai-fishing", occurredOn: "2025-06-15", subjectLabel: "Пётр",
    kind: "episode", scope: "family", updatedAt: "2025-06-16" },
  { content: "Сломался бойлер в квартире, мастер поменял тэн, ремонт занял полдня.",
    key: "boiler-repair", occurredOn: "2025-03-03", subjectLabel: "Семья Соколовых",
    kind: "episode", scope: "family", updatedAt: "2025-03-04" },
  { content: "Пётр сдал экзамен по физике на отлично, лучше всех решил задачу про рычаги.",
    key: "physics-exam", occurredOn: { daysAgo: 1 }, subjectLabel: "Пётр",
    kind: "episode", scope: "family", updatedAt: "2025-09-20" },
  { content: "Фёдору купили новый тонометр и записали его к кардиологу на следующую среду.",
    key: "fedor-tonometer", occurredOn: { daysAgo: 2 }, subjectLabel: "Фёдор",
    kind: "episode", scope: "family", updatedAt: "2025-09-20" },
  { content: "Сантехник поменял смеситель на кухне, старый протекал под мойкой.",
    key: "kitchen-faucet", occurredOn: { daysAgo: 7 }, subjectLabel: "Семья Соколовых",
    kind: "episode", scope: "family", updatedAt: "2025-09-20" },

  { content: "Интернет-тариф дома — Поток 300, оплачивают десятого числа.",
    key: "internet-plan-earlier", subjectLabel: "Семья Соколовых", supersededBy: "internet-plan",
    kind: "fact", scope: "family", updatedAt: "2025-03-16" },
  { content: "Машину обслуживали в сервисе Гайка на Лесной, мастер Павел Кудрин.",
    key: "car-service-earlier", subjectLabel: "Машина Олега", supersededBy: "car-service",
    kind: "fact", scope: "family", updatedAt: "2025-02-14" },
  { content: "Размер обуви Петра — сорок первый.",
    key: "petr-shoe-size-earlier", subjectLabel: "Пётр", supersededBy: "petr-shoe-size",
    kind: "fact", scope: "family", updatedAt: "2024-07-17" },
  { content: "Олег предпочитает получать напоминания утром, до начала работы.",
    key: "oleg-reminder-time-earlier", subjectLabel: "Олег", supersededBy: "oleg-reminder-time",
    kind: "preference", scope: "personal", updatedAt: "2025-01-16" },
];
