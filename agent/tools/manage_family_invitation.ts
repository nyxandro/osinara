/**
 * Consolidated family invitation mutation tool.
 *
 * Export:
 * - `manage_family_invitation`: creates a one-time invitation or approves a candidate.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root discriminator unions in Eve descriptors.
 * - Input validators prevent malformed payloads from reaching invitation side effects.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import { familyRepository } from "../lib/family-repository.js";
import { deliverFamilyInvitation } from "../lib/telegram-delivery.js";
import {
  requireAction,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_FAMILY_INVITATION_INPUT_INVALID";
const TOOL_ACTIONS = ["create", "approve"] as const;
const TOP_LEVEL_FIELDS = [
  "action",
  "candidateDisplayName",
  "candidateTelegramUserId",
  "invitationId",
] as const;

const manageFamilyInvitationSchema = z.object({
  action: z.string().optional(),
  candidateDisplayName: z.string().optional(),
  candidateTelegramUserId: z.string().optional(),
  invitationId: z.string().optional(),
}).passthrough();

function requireApproveInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "candidateDisplayName",
    "candidateTelegramUserId",
    "invitationId",
  ], "action=approve", INPUT_ERROR_CODE);
  return {
    candidateDisplayName: requiredString(input, "candidateDisplayName", INPUT_ERROR_CODE, "Анна", {
      maxLength: 200,
    }),
    candidateTelegramUserId: requiredString(input, "candidateTelegramUserId", INPUT_ERROR_CODE, "123456789", {
      maxLength: 64,
    }),
    invitationId: requiredUuid(input, "invitationId", INPUT_ERROR_CODE, "приглашение из list_pending_family_invitations"),
  };
}

const TOOL_DESCRIPTION = [
  "Создать одноразовое семейное приглашение или подтвердить кандидата из list_pending_family_invitations.",
  "Доступно только владельцу в личном чате. Create payload: {\"action\":\"create\"}.",
  "Approve payload: {\"action\":\"approve\",\"invitationId\":\"uuid\",\"candidateTelegramUserId\":\"123456789\",\"candidateDisplayName\":\"Анна\"}.",
].join(" ");

export default defineTool({
  approval: always(),
  description: TOOL_DESCRIPTION,
  inputSchema: manageFamilyInvitationSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_family_invitation", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_family_invitation", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_family_invitation", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const owner = requirePrivateTelegramOwner(ctx);
    if (action === "approve") {
      const candidate = requireApproveInput(payload);
      return await familyRepository.approveInvitation({
        approvedBy: owner.userId,
        familyId: owner.familyId,
        operationKey: ctx.callId,
        ...candidate,
      });
    }

    requireOnlyFields(payload, ["action"], "action=create", INPUT_ERROR_CODE);
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
