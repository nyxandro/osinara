/**
 * What the application gives the runtime to run its agent.
 *
 * Exports:
 * - `RuntimeAgent`: base prompt, turn instruction resolvers, per-step tools, skills, model choice
 *   and the turn limits.
 * - `StepModelSelection`: the model of one step with its provider options and context window.
 *
 * Replaces eve 0.40.0 `defineAgent`/`defineDynamic` for the parts Osinara configures. Every member
 * is explicit: the runtime has no fallback model, no default resolver order and no default limits.
 */
import type { LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import type { DynamicResolveContext } from "./context.js";
import type { InstructionResolver } from "./prompt/turn-instructions.js";
import type { SkillDefinition } from "./skills/definition.js";
import type { ToolDefinition } from "./tool.js";

export interface StepModelSelection {
  readonly contextWindowTokens: number;
  readonly model: LanguageModel;
  readonly providerOptions: SharedV4ProviderOptions | undefined;
}

export interface RuntimeAgent {
  /** `composeBasePrompt` output: authored instructions plus the runtime's fixed rules. */
  readonly basePrompt: string;
  /** Share of the model's context window at which history is compacted before a step. */
  readonly compactionThresholdPercent: number;
  /** Resolvers in the order their blocks appear; they run once per turn. */
  readonly instructionResolvers: readonly InstructionResolver[];
  /** Model calls one turn may make; the next one fails the turn with a coded error. */
  readonly maxModelSteps: number;
  /** Authored tools placed right after the built-ins, before `agent` and the surface. */
  readonly staticToolNames: readonly string[];
  /** The turn's skills by name; the runtime syncs their packages into the sandbox and lists them. */
  resolveSkills(context: DynamicResolveContext): Promise<Readonly<Record<string, SkillDefinition>>>;
  /** The whole tool surface of one step; it is rebuilt before every model call. */
  resolveTools(context: DynamicResolveContext): Promise<Readonly<Record<string, ToolDefinition<any, any>>>>;
  selectModel(input: { readonly sessionId: string; readonly stepIndex: number }): StepModelSelection;
}
