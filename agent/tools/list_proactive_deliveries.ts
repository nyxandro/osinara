/**
 * Eve history tool for delivered reminders and scheduled-agent results.
 *
 * Export:
 * - `list_proactive_deliveries`: searches successful deliveries in the current trust zone.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import {
  proactiveDeliveryRepository,
  type ProactiveDeliveryAuthorization,
} from "../lib/proactive-deliveries/proactive-delivery-repository.js";

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
  ].join(" "),
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200).optional(),
    sourceKind: z.enum(["agent_schedule", "reminder"]).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await proactiveDeliveryRepository.list({
      ...requireDeliveryAuthorization(ctx),
      query: input.query ?? null,
      sourceKind: input.sourceKind ?? null,
    });
  },
});
