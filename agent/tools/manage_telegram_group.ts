/**
 * Consolidated Telegram group administration tool.
 *
 * Export:
 * - `manage_telegram_group` registers or removes a family-scoped trust zone.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import { telegramGroupAdministrationRepository } from "../lib/telegram-group-administration-repository.js";
import {
  telegramGroupIdSchema,
  telegramGroupRegistrationInputSchema,
} from "../lib/telegram-group-registration.js";

const manageTelegramGroupSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register"),
    registration: telegramGroupRegistrationInputSchema,
  }).strict(),
  z.object({ action: z.literal("remove"), telegramChatId: telegramGroupIdSchema }).strict(),
]);

export default defineTool({
  approval: always(),
  description:
    "Зарегистрировать Telegram-группу как trust zone или удалить существующую регистрацию и связанные групповые данные.",
  inputSchema: manageTelegramGroupSchema,
  async execute(input, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    if (input.action === "remove") {
      await telegramGroupAdministrationRepository.removeGroup({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        telegramChatId: input.telegramChatId,
      });
      return { deleted: true, telegramChatId: input.telegramChatId };
    }

    const registration = input.registration;
    const result = await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      familyId: owner.familyId,
      requestedBy: owner.userId,
      toolAllowlist: registration.type === "family_private" ? [] : registration.toolAllowlist,
    });
    return {
      active: true,
      groupId: result.groupId,
      messageMode: registration.messageMode,
      telegramChatId: registration.telegramChatId,
      title: registration.title,
      type: registration.type,
    };
  },
});
