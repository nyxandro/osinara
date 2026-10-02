/**
 * Osinara agent configuration for the runtime.
 *
 * Constructs covered:
 * - The step limit and the compaction threshold come from `agent/config.ts`.
 * - The base prompt starts with the authored instructions under Eve's header.
 * - Turn blocks run in their explicit order; the model choice carries the session routing.
 * - Skills come from the conversation's scoped resolver.
 */
import { describe, expect, it } from "vitest";

import { createOsinaraAgent } from "../agent.js";
import { AGENT_COMPACTION_THRESHOLD, AGENT_MAX_MODEL_STEPS_PER_TURN } from "../config.js";
import { modelProviderConfig } from "./model-provider-config.js";
import { primaryModel } from "./model-registry.js";
import { resolveScopedSkills } from "../skills/scoped.js";
import { resolveToolSurface } from "../tools/capabilities.js";

const CONTEXT = {
  channel: { kind: "telegram" },
  messages: [],
  session: { auth: { current: null, initiator: null }, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR" },
};

describe("Osinara agent", () => {
  const agent = createOsinaraAgent();

  it("takes its limits from the project configuration", () => {
    expect(agent.maxModelSteps).toBe(AGENT_MAX_MODEL_STEPS_PER_TURN);
    expect(agent.compactionThresholdPercent).toBe(AGENT_COMPACTION_THRESHOLD);
    expect(agent.basePrompt).toMatch(/^Instructions \(instructions\)\n\S/);
    expect(agent.basePrompt).toMatch(/\n\nTool execution\nA single tool or subagent call runs as one serial action\./);
  });

  it("resolves the turn blocks in their fixed order", () => {
    expect(agent.instructionResolvers.map((resolver) => resolver.name)).toEqual([
      "conversation-mode", "delegation", "presentation-preferences", "reaction-set", "retrieved-memory",
    ]);
  });

  it("routes every step to the primary model with the session's provider options", () => {
    const selection = agent.selectModel({ sessionId: CONTEXT.session.id, stepIndex: 3 });

    expect(selection.model).toBe(primaryModel);
    expect(selection.contextWindowTokens).toBe(modelProviderConfig.agent.models.primary.contextWindowTokens);
    expect(selection.providerOptions).toEqual(modelProviderConfig.provider === "neuraldeep"
      ? { neuraldeep: { user: CONTEXT.session.id } }
      : undefined);
  });

  it("takes tools and skills from the verified conversation resolvers", () => {
    expect(agent.resolveTools).toBe(resolveToolSurface);
    expect(agent.resolveSkills).toBe(resolveScopedSkills);
  });
});
