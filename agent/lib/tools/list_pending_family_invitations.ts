/**
 * Pending family invitation listing tool.
 *
 * Export:
 * - Owner-only candidate list used before a structured approval.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../family-context.js";
import { familyRepository } from "../family-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: "Показать владельцу ожидающих подтверждения кандидатов в семью.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    return await familyRepository.listPendingInvitations(owner.familyId, owner.userId);
  },
});
