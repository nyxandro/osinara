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
} from "./config.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";

const primaryModelContextWindowTokens = modelProviderConfig.agent.contextWindowTokens;

export default defineAgent({
  compaction: {
    modelContextWindowTokens: primaryModelContextWindowTokens,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  limits: {
    maxSubagentDepth: AGENT_MAX_SUBAGENT_DEPTH,
  },
  model: primaryModel,
  modelContextWindowTokens: primaryModelContextWindowTokens,
});
