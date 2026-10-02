/**
 * Tool for the current verified Telegram group timeline.
 *
 * Export:
 * - `list_group_history`: bounded pagination and search without a model-selectable group scope.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { searchTelegramGroupHistory } from "../telegram-group-history.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { loadCurrentExternalGroupCapabilities } from "../tool-policy/external-group-live-policy.js";

const POSITIVE_BIGINT = z.string().regex(/^[1-9]\d*$/u);

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "Читает сохранённую историю всей текущей verified Telegram-группы, включая другие форумные темы; group ID и scope определяются авторизацией и не передаются.",
    "Результат содержит записи в хронологическом порядке и nextBeforeSequence для следующей страницы; без фильтров возвращаются последние сообщения.",
    "query ищет регистронезависимую буквальную подстроку в content: это не семантический поиск, не поиск синонимов и не нечёткий поиск.",
    "participant требует точный username без @; sequenceFrom и sequenceTo включительны, beforeSequence исключителен, from и to включительны.",
    "limit от 1 до 100 применяется после всех фильтров; одновременно заданные фильтры объединяются через AND.",
    "Делай только один вызов на model step, дождись и проверь его результат перед следующим вызовом: несколько параллельных проверок нельзя сопоставлять по порядку ответа.",
    "Примеры: последние 3: {\"limit\":3}; буквальный поиск: {\"query\":\"кондиционер\",\"limit\":20}; участник: {\"participant\":\"nyxandro\",\"limit\":20}; следующая страница: {\"beforeSequence\":\"320\",\"limit\":3}; диапазон: {\"sequenceFrom\":\"310\",\"sequenceTo\":\"315\"}; время: {\"from\":\"2026-07-31T16:00:00Z\",\"to\":\"2026-07-31T18:00:00Z\"}.",
  ].join(" "),
  inputSchema: z.object({
    beforeSequence: POSITIVE_BIGINT.describe(
      "Исключительная верхняя граница: вернуть записи с sequence строго меньше указанного. Для следующей страницы передай nextBeforeSequence предыдущего результата.",
    ).optional(),
    from: z.iso.datetime({ offset: true }).describe(
      "Нижняя граница sentAt включительно. Передавай ISO 8601 datetime с UTC offset, например 2026-07-31T16:00:00Z.",
    ).optional(),
    limit: z.number().int().min(1).max(100).describe(
      "Число наиболее свежих подходящих записей после применения всех фильтров, от 1 до 100. По умолчанию 25.",
    ).optional(),
    participant: z.string().trim().min(1).max(200).describe(
      "Точный username участника без символа @. Не включает ответы агента или похожие имена и не выполняет нечёткий поиск.",
    ).optional(),
    query: z.string().trim().min(1).max(500).describe(
      "Регистронезависимая буквальная подстрока в content. Не ищет синонимы, смысловые совпадения или словоформы без совпавшего текста.",
    ).optional(),
    sequenceFrom: POSITIVE_BIGINT.describe(
      "Нижняя граница model-visible sequence включительно, например 310 включает #310.",
    ).optional(),
    sequenceTo: POSITIVE_BIGINT.describe(
      "Верхняя граница model-visible sequence включительно, например 315 включает #315.",
    ).optional(),
    to: z.iso.datetime({ offset: true }).describe(
      "Верхняя граница sentAt включительно. Передавай ISO 8601 datetime с UTC offset, например 2026-07-31T18:00:00Z.",
    ).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await searchTelegramGroupHistory(
      telegramGroupJournalRepository,
      input,
      ctx,
      loadCurrentExternalGroupCapabilities,
    );
  },
});
