/**
 * Consolidated family invitation mutation tool.
 *
 * Export:
 * - `manage_family_invitation` creates a one-time invitation or approves a candidate.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import { familyRepository } from "../lib/family-repository.js";
import { deliverFamilyInvitation } from "../lib/telegram-delivery.js";

const manageFamilyInvitationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }).strict(),
  z.object({
    action: z.literal("approve"),
    candidateDisplayName: z.string().min(1).max(200),
    candidateTelegramUserId: z.string().min(1).max(64),
    invitationId: z.string().uuid(),
  }).strict(),
]);

export default defineTool({
  approval: always(),
  description:
    "Создать одноразовое семейное приглашение или подтвердить кандидата из list_pending_family_invitations. Доступно владельцу в личном чате.",
  inputSchema: manageFamilyInvitationSchema,
  async execute(input, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    if (input.action === "approve") {
      const { action: _action, ...candidate } = input;
      return await familyRepository.approveInvitation({
        approvedBy: owner.userId,
        familyId: owner.familyId,
        operationKey: ctx.callId,
        ...candidate,
      });
    }

    const invitation = await familyRepository.createInvitation(
      owner.familyId,
      owner.userId,
      ctx.callId,
    );
    if (invitation.deliveryRequired) {
      // Authorization is rechecked immediately before the external Telegram side effect.
      await familyRepository.assertCurrentOwner(owner.familyId, owner.userId);
      await deliverFamilyInvitation({
        chatId: owner.telegramChatId,
        code: invitation.code,
        expiresAt: invitation.expiresAt,
        signal: ctx.abortSignal,
      });
      await familyRepository.markInvitationDelivered({
        createdBy: owner.userId,
        familyId: owner.familyId,
        invitationId: invitation.invitationId,
        operationKey: ctx.callId,
      });
    }
    return { delivered: true, expiresAt: invitation.expiresAt };
  },
});
