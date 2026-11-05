/**
 * Consolidated family invitation mutation tool.
 *
 * Export:
 * - `manage_family_invitation`: lists the candidates waiting for confirmation, creates a one-time
 *   invitation or approves a candidate.
 *
 * Key constructs:
 * - Object-shaped model schema publishes a required finite action discriminator.
 * - One semantic parser validates both approval and execution inputs; the list asks no confirmation.
 * - Input validators prevent malformed payloads from reaching invitation side effects.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { isAppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { familyRepository } from "../family-repository.js";
import { deliverFamilyInvitation } from "../telegram-delivery.js";
import { withCallExamples, type CallExamples } from "../tool-call-examples.js";
import {
  requireAction,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_FAMILY_INVITATION_INPUT_INVALID";
const TOOL_ACTIONS = ["list", "create", "approve"] as const;
const TOP_LEVEL_FIELDS = [
  "action",
  "candidateDisplayName",
  "candidateTelegramUserId",
  "invitationId",
] as const;

const manageFamilyInvitationSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: list, create or approve."),
  candidateDisplayName: z.string().optional().describe("Required only for action=approve."),
  candidateTelegramUserId: z.string().optional().describe("Required only for action=approve."),
  invitationId: z.string().optional().describe("A UUID, required only for action=approve."),
}).strict();

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
    invitationId: requiredUuid(input, "invitationId", INPUT_ERROR_CODE, "приглашение из manage_family_invitation с action=list"),
  };
}

function requireManageFamilyInvitationInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_family_invitation", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_family_invitation", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_family_invitation", TOOL_ACTIONS, INPUT_ERROR_CODE);

  if (action === "list") {
    requireOnlyFields(payload, ["action"], "action=list", INPUT_ERROR_CODE);
    return { action } as const;
  }
  // MiniMax may materialize known approve-only siblings for create. Creation ignores them and
  // cannot bind a candidate accidentally; unpublished fields still fail in the global guard.
  if (action === "create") return { action } as const;
  return { action, candidate: requireApproveInput(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Show the family candidates waiting for confirmation, create a one-time family invitation or approve a candidate from that list; only the owner can use it. Create and approve ask for confirmation, the list does not.",
  "List: {\"action\":\"list\"}.",
  "Create: {\"action\":\"create\"} with no candidate fields.",
  "Approve: {\"action\":\"approve\",\"invitationId\":\"<UUID from the list>\",\"candidateTelegramUserId\":\"123456789\",\"candidateDisplayName\":\"Анна\"}, all three copied exactly from the chosen candidate; never guess them.",
].join(" ");

export const MANAGE_FAMILY_INVITATION_CALL_EXAMPLES: CallExamples = {
  list: { action: "list" },
  create: { action: "create" },
  approve: { action: "approve", invitationId: "<UUID из списка action=list>", candidateTelegramUserId: "123456789", candidateDisplayName: "Анна" },
};

export default withCallExamples(defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  approval: ({ toolInput }) => {
    try {
      // Reading the list changes nothing, so the owner is not asked to confirm it.
      return requireManageFamilyInvitationInput(toolInput).action === "list" ? "not-applicable" : "user-approval";
    } catch (error) {
      // An invalid call goes on to execution, whose own check refuses it before any change and
      // answers with an example; thrown here, it would end the turn.
      if (isAppError(error)) return "not-applicable";
      throw error;
    }
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageFamilyInvitationSchema,
  async execute(input, ctx) {
    const parsed = requireManageFamilyInvitationInput(input);
    const owner = requirePrivateTelegramOwner(ctx);
    if (parsed.action === "list") return await familyRepository.listPendingInvitations(owner.familyId, owner.userId);
    if (parsed.action === "approve") {
      return await familyRepository.approveInvitation({
        approvedBy: owner.userId,
        familyId: owner.familyId,
        operationKey: ctx.callId,
        ...parsed.candidate,
      });
    }

    const invitation = await familyRepository.createInvitation(
      owner.familyId,
      owner.userId,
      ctx.callId,
    );
    if (invitation.deliveryRequired) {
      // The repository persists one transport attempt and rechecks live owner access before send.
      await familyRepository.markInvitationDeliveryStarted({
        createdBy: owner.userId,
        familyId: owner.familyId,
        invitationId: invitation.invitationId,
        operationKey: ctx.callId,
      });
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
}), MANAGE_FAMILY_INVITATION_CALL_EXAMPLES);
