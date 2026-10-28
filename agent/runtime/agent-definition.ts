/**
 * What the application gives the runtime to run its agent.
 *
 * Exports:
 * - `RuntimeAgent`: base prompt, turn instruction resolvers, per-step tools, skills, model choice,
 *   the turn limits, the call before each model step and the check of a final answer.
 * - `StepStartContext`: what that call sees.
 * - `StepModelSelection`: the model of one step with its provider options and context window.
 *
 * Every member is explicit: the runtime has no fallback model, no default resolver order and no
 * default limits.
 */
import type { LanguageModel, ModelMessage } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import type { DynamicResolveContext, SessionAuth, SessionParent, SessionTurn } from "./context.js";
import type { InstructionResolver } from "./prompt/turn-instructions.js";
import type { SkillDefinition } from "./skills/definition.js";
import type { ToolDefinition } from "./tool.js";

export interface StepModelSelection {
  readonly contextWindowTokens: number;
  readonly model: LanguageModel;
  readonly providerOptions: SharedV4ProviderOptions | undefined;
}

export interface StepStartContext {
  readonly channel: DynamicResolveContext["channel"];
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
    /** Set for a delegated child turn. */
    readonly parent?: SessionParent;
    readonly turn: SessionTurn;
  };
}

export interface RuntimeAgent {
  /** `composeBasePrompt` output: authored instructions plus the runtime's fixed rules. */
  readonly basePrompt: string;
  /**
   * Checks the text a step ends the turn with, before it is recorded or delivered. A notice sends
   * the answer back to the model once with it; `undefined` accepts the answer.
   */
  checkFinalAnswer(context: StepStartContext & { readonly text: string }): Promise<string | undefined>;
  /** Share of the model's context window at which history is compacted before a step. */
  readonly compactionThresholdPercent: number;
  /** Resolvers in the order their blocks appear; they run once per turn. */
  readonly instructionResolvers: readonly InstructionResolver[];
  /** Model calls one turn may make; the next one fails the turn with a coded error. */
  readonly maxModelSteps: number;
  /** History messages the application sends again after a compaction; the summary leaves them out. */
  readonly restatedAfterCompaction: (message: ModelMessage) => boolean;
  /** Authored tools placed right after the built-ins, before `agent` and the surface. */
  readonly staticToolNames: readonly string[];
  /** The turn's skills by name; the runtime syncs their packages into the sandbox and lists them. */
  resolveSkills(context: DynamicResolveContext): Promise<Readonly<Record<string, SkillDefinition>>>;
  /** The whole tool surface of one step; it is rebuilt before every model call. */
  resolveTools(context: DynamicResolveContext): Promise<Readonly<Record<string, ToolDefinition<any, any>>>>;
  selectModel(input: { readonly sessionId: string; readonly stepIndex: number }): StepModelSelection;
  /**
   * Runs right before each model call of a turn: every tool result of
   * the previous step is in that call's prompt. Not run again for a step recorded before a crash.
   */
  stepStarted(context: StepStartContext): Promise<void>;
}
