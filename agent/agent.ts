/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Context compaction and a zero-depth delegation boundary for the root agent.
 */
import { defineAgent } from "eve";

import {
  AGENT_COMPACTION_THRESHOLD,
  AGENT_MAX_SUBAGENT_DEPTH,
  PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
} from "./config.js";
import { primaryModel } from "./lib/model-registry.js";

export default defineAgent({
  compaction: {
    modelContextWindowTokens: PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  limits: {
    maxSubagentDepth: AGENT_MAX_SUBAGENT_DEPTH,
  },
  model: primaryModel,
  modelContextWindowTokens: PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
});
