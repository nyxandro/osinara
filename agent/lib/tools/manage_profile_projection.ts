/**
 * Owner-only external self-profile projection policy tool.
 *
 * Export:
 * - `manage_profile_projection`: lists opaque group refs or updates one explicit opt-in policy.
 */
import { defineTool } from "eve/tools";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { profileProjectionInputSchema } from "../profile-projection-input.js";

export default defineTool({
  approval: ({ toolInput }) => toolInput?.action === "update" ? "user-approval" : "not-applicable",
  description:
    "В личном чате владельца показать или изменить перенос фактов из внешней группы в личные профили участников. Настройка действует на группу: каждый участник, связанный с семейной учётной записью, получает только сведения о себе; личная и семейная память группе не раскрывается. Доступ появляется после доставки уведомления в группу. Сначала вызови {\"action\":\"list\"}: результат policies содержит актуальные opaque groupRef. Для изменения используй только {\"action\":\"update\",\"enabled\":true|false,\"groupRef\":\"grp_...\"}; update требует Eve HITL. Не придумывай groupRef и не используй Telegram chat ID.",
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
