/**
 * Dynamic long-term memory instructions.
 *
 * Export:
 * - Turn-scoped Eve instructions containing only authorized memory records.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { requireMemoryAuthorization } from "../lib/memory-context.js";
import {
  formatRetrievedMemoryInstructions,
  latestUserText,
  retrieveRelevantMemories,
} from "../lib/memory-retrieval.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const authorization = requireMemoryAuthorization(ctx);
      const query = latestUserText(ctx.messages);
      if (!query) return null;
      const memories = await retrieveRelevantMemories(authorization, query);
      return defineInstructions({
        markdown: formatRetrievedMemoryInstructions(memories),
      });
    },
  },
});
