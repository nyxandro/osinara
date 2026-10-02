/**
 * Osinara's agent as the runtime runs it.
 *
 * Export:
 * - `createOsinaraAgent`: the base prompt from `instructions.md`, the turn blocks in their fixed
 *   order, the tool surface and skills of the verified conversation, the primary model with
 *   NeuralDeep session routing, the step limit and the compaction threshold.
 *
 * The block order is explicit here (Eve derived it from file names): the trust zone rules first,
 * then delegation and chat preferences, the reaction set (a user-role history entry), and the
 * volatile memory payload last.
 */
import { readFileSync } from "node:fs";

import { AGENT_COMPACTION_THRESHOLD, AGENT_MAX_MODEL_STEPS_PER_TURN } from "./config.js";
import { conversationModeInstructions } from "./instructions/conversation-mode.js";
import { delegationInstructions } from "./instructions/delegation.js";
import { presentationPreferenceInstructions } from "./instructions/presentation-preferences.js";
import { reactionSetInstructions } from "./instructions/reaction-set.js";
import { retrievedMemoryInstructions } from "./instructions/retrieved-memory.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { primaryModel } from "./lib/model-registry.js";
import { resolveSessionModelSelection } from "./lib/neuraldeep-session-routing.js";
import type { RuntimeAgent } from "./runtime/agent-definition.js";
import type { SessionAuth } from "./runtime/context.js";
import { composeBasePrompt } from "./runtime/prompt/system-prompt.js";
import { resolveScopedSkills } from "./skills/scoped.js";
import { resolveToolSurface } from "./tools/capabilities.js";

const AUTHORED_INSTRUCTIONS = { content: readFileSync(new URL("./instructions.md", import.meta.url), "utf8"), name: "instructions" };

export function createOsinaraAgent(dependencies: {
  /** Where the sandbox keeps skill packages; the skill list in the prompt points there. */
  readonly skillRoot: (session: { readonly auth: SessionAuth; readonly id: string }) => Promise<string>;
}): RuntimeAgent {
  const contextWindowTokens = modelProviderConfig.agent.models.primary.contextWindowTokens;
  return {
    basePrompt: composeBasePrompt({ instructions: AUTHORED_INSTRUCTIONS, toolsAvailable: true }),
    compactionThresholdPercent: AGENT_COMPACTION_THRESHOLD,
    instructionResolvers: [
      conversationModeInstructions,
      delegationInstructions,
      presentationPreferenceInstructions,
      reactionSetInstructions,
      retrievedMemoryInstructions,
    ],
    maxModelSteps: AGENT_MAX_MODEL_STEPS_PER_TURN,
    async resolveSkills(context) {
      const skills = Object.entries(await resolveScopedSkills(context))
        .map(([name, skill]) => ({ description: skill.description, name }));
      if (skills.length === 0) return { skillRoot: null, skills };
      return { skillRoot: await dependencies.skillRoot(context.session), skills };
    },
    resolveTools: resolveToolSurface,
    selectModel: ({ sessionId }) => resolveSessionModelSelection({
      model: primaryModel,
      modelContextWindowTokens: contextWindowTokens,
      providerId: modelProviderConfig.provider,
      sessionId,
    }),
    staticToolNames: [],
  };
}
