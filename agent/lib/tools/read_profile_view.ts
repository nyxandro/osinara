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
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description:
    "Перечитать подборку сведений о людях из блока <verified_profile_view> по её profileViewRef, например когда блок обрезан или ушёл из контекста. Возвращает ту же подборку, новую не собирает.",
  inputSchema: z.object({
    profileViewRef: z.string().regex(PROFILE_VIEW_REF_PATTERN),
  }).strict(),
  async execute(input, ctx) {
    return await profileViewRepository.read(requireMemoryAuthorization(ctx), input.profileViewRef);
  },
});
