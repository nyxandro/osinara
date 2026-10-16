/**
 * History tool for delivered reminders and scheduled-agent results.
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
import { isoDateTimeWithOffset } from "../model-facing-datetime.js";
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
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "Show reminders and agent schedule results previously delivered to the current chat.",
    "Use it when the user refers to an old digest, report, summary or notification that is no longer in the current context.",
    "query searches the title and text; sourceKind limits the results to agent_schedule or reminder.",
    "deliveredAfter and deliveredBefore set an inclusive period of delivery time as an ISO datetime.",
    "Result: {items,nextCursor}; each item has separate deliveryId and sourceId fields. For the next page pass nextCursor unchanged.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    deliveredAfter: isoDateTimeWithOffset("The start of the period, inclusive, for example 2026-10-01T00:00:00+03:00.").optional(),
    deliveredBefore: isoDateTimeWithOffset("The end of the period, inclusive, for example 2026-10-07T23:59:59+03:00.").optional(),
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
