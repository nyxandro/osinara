/**
 * Eve history tool for delivered reminders and scheduled-agent results.
 *
 * Export:
 * - `list_proactive_deliveries`: searches successful deliveries in the current trust zone.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import {
  PROACTIVE_DELIVERY_HISTORY_DEFAULT_LIMIT,
  PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import {
  proactiveDeliveryRepository,
  type ProactiveDeliveryAuthorization,
} from "../proactive-deliveries/proactive-delivery-repository.js";

function requireDeliveryAuthorization(
  ctx: Parameters<typeof requireReminderAuthorization>[0],
): ProactiveDeliveryAuthorization {
  const authorization = requireReminderAuthorization(ctx);
  if (authorization.telegramChatType === "private" && authorization.groupId === null) {
    return {
      familyId: authorization.familyId,
      groupId: null,
      messageThreadId: null,
      ownerUserId: authorization.userId,
      scope: "personal",
      telegramChatId: authorization.telegramChatId,
    };
  }
  if (authorization.groupType === "family_private" && authorization.groupId !== null) {
    return {
      familyId: authorization.familyId,
      groupId: authorization.groupId,
      messageThreadId: authorization.messageThreadId,
      ownerUserId: null,
      scope: "family",
      telegramChatId: authorization.telegramChatId,
    };
  }
  throw new AppError(
    "AGENT_PROACTIVE_DELIVERY_SCOPE_DENIED",
    "История уведомлений доступна только в личном чате или семейной группе",
  );
}

export default defineTool({
  description: [
    "Показать ранее доставленные в текущий чат напоминания и результаты агентных расписаний.",
    "Используй, когда пользователь ссылается на старый дайджест, отчёт, сводку или уведомление, которого уже нет в текущем контексте.",
    "query ищет по заголовку и тексту; sourceKind ограничивает результаты типом agent_schedule или reminder.",
    "deliveredAfter и deliveredBefore задают включительный период по времени доставки в ISO datetime.",
    "Результат: {items,nextCursor}; каждый item содержит отдельные поля deliveryId и sourceId. Для следующей страницы передай nextCursor без изменений.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    deliveredAfter: z.string().datetime({ offset: true }).optional(),
    deliveredBefore: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT)
      .default(PROACTIVE_DELIVERY_HISTORY_DEFAULT_LIMIT),
    query: z.string().trim().min(1).max(200).optional(),
    sourceKind: z.enum(["agent_schedule", "reminder"]).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await proactiveDeliveryRepository.list({
      ...requireDeliveryAuthorization(ctx),
      cursor: input.cursor,
      deliveredAfter: input.deliveredAfter ? new Date(input.deliveredAfter) : null,
      deliveredBefore: input.deliveredBefore ? new Date(input.deliveredBefore) : null,
      limit: input.limit,
      query: input.query ?? null,
      sourceKind: input.sourceKind ?? null,
    });
  },
});
