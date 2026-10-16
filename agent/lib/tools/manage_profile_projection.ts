/**
 * Owner-only external self-profile projection policy tool.
 *
 * Export:
 * - `manage_profile_projection`: lists opaque group refs or updates one explicit opt-in policy.
 */
import { defineTool } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { profileProjectionInputSchema } from "../profile-projection-input.js";

export default defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  approval: ({ toolInput }) => toolInput?.action === "update" ? "user-approval" : "not-applicable",
  description:
    "In the owner's private chat, show or change the transfer of facts from an external group into the participants' personal profiles. The setting applies to the group: each participant linked to a family account gets only facts about themselves; personal and family memory is not revealed to the group. Access appears after the notification is delivered to the group. First call {\"action\":\"list\"}: the policies result contains the current opaque groupRef. To change it use only {\"action\":\"update\",\"enabled\":true|false,\"groupRef\":\"grp_...\"}; update requires a person's confirmation. Do not invent a groupRef and do not use a Telegram chat ID.",
  inputSchema: profileProjectionInputSchema,
  async execute(input, ctx) {
    requirePrivateTelegramOwner(ctx);
    const auth = requireMemoryAuthorization(ctx);
    if (input.action === "list") {
      if (input.enabled !== undefined || input.groupRef !== undefined) {
        throw new AppError(
          "AGENT_PROFILE_PROJECTION_INPUT_INVALID",
          "Для action=list не передавайте enabled или groupRef",
        );
      }
      return { policies: await profileProjectionPolicyRepository.list(auth) };
    }
    if (input.enabled === undefined || input.groupRef === undefined) {
      throw new AppError(
        "AGENT_PROFILE_PROJECTION_INPUT_INVALID",
        "Для action=update обязательны opaque groupRef и enabled",
      );
    }
    // Owner role and exact Telegram approval are both revalidated at the mutation boundary.
    await requireToolApprovalEvidence(ctx, "manage_profile_projection", input);
    return await profileProjectionPolicyRepository.update(auth, {
      enabled: input.enabled,
      groupRef: input.groupRef,
      operationKey: ctx.callId,
    });
  },
});
