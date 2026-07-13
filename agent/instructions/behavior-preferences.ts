/**
 * Dynamic typed behavior preference instructions.
 *
 * Export:
 * - Turn-scoped Eve instructions built only from fixed safe preference mappings.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { buildBehaviorPreferenceInstructions } from "../lib/behavior-preferences.js";
import { behaviorPreferenceRepository } from "../lib/behavior-preference-repository.js";
import { requireMemoryAuthorization } from "../lib/memory-context.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const authorization = requireMemoryAuthorization(ctx);
      const records = await behaviorPreferenceRepository.list(authorization);
      const markdown = buildBehaviorPreferenceInstructions(records);
      return markdown ? defineInstructions({ markdown }) : null;
    },
  },
});
