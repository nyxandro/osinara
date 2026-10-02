/**
 * Reproducible profile view reader tool.
 *
 * Export:
 * - `read_profile_view`: reads the exact ordered snapshot when current access is unchanged.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { profileViewRepository } from "../profile-view-repository.js";

const PROFILE_VIEW_REF_PATTERN = /^view_[0-9a-f]{32}$/u;

export default defineTool({
  description:
    "Повторно прочитать точный ordered profile selection по profileViewRef; не создаёт новую выборку.",
  inputSchema: z.object({
    profileViewRef: z.string().regex(PROFILE_VIEW_REF_PATTERN),
  }).strict(),
  async execute(input, ctx) {
    return await profileViewRepository.read(requireMemoryAuthorization(ctx), input.profileViewRef);
  },
});
