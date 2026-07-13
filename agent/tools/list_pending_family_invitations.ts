/**
 * Pending family invitation listing tool.
 *
 * Export:
 * - Owner-only candidate list used before a structured approval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import { familyRepository } from "../lib/family-repository.js";

export default defineTool({
  description: "Показать владельцу ожидающих подтверждения кандидатов в семью.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    return await familyRepository.listPendingInvitations(owner.familyId, owner.userId);
  },
});
