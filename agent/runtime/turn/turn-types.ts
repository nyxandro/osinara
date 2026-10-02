/**
 * Shapes of a turn as the journal stores it.
 *
 * Exports:
 * - `TurnKind`, `TurnStatus`, `TurnRecord`: one turn and its lifecycle.
 * - `TurnChannel`: where the turn came from and where its answer goes.
 * - `PreparedTurn`: turn-scoped instructions and skills, resolved once at the start.
 * - `ToolCallRecord`, `TurnStepRecord`: one model step and the tool calls it made.
 */
import type { ModelMessage, UserContent } from "ai";

import type { SessionAuth } from "../context.js";
import type { JsonObject } from "../json.js";
import type { InputRequest, InputResponse } from "../hitl/types.js";
import type { AvailableSkillDescription } from "../prompt/skills-section.js";
import type { ToolResultOutput } from "./tool-calls.js";

export type TurnKind = "conversation" | "memory_review" | "scheduled" | "subagent" | "wakeup";
export type TurnStatus = "cancelled" | "completed" | "failed" | "running" | "waiting_input";

export interface TurnChannel {
  /** `"telegram"`, `"memory-review"` or `"subagent"`, as resolvers read `ctx.channel.kind`. */
  readonly kind: string;
  readonly continuationToken?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TurnStartInput {
  readonly context: readonly string[];
  readonly message?: string | UserContent;
  /** A child asked for structured output answers through `final_output` with this schema. */
  readonly outputSchema?: JsonObject;
}

export interface PreparedTurn {
  /** System blocks of this turn, after the base prompt. */
  readonly instructions: readonly string[];
  /** User-role blocks written into history with the turn input. */
  readonly userInstructions: readonly ModelMessage[];
  readonly skills: readonly AvailableSkillDescription[];
  readonly skillRoot: string | null;
}

export interface TurnRecord {
  readonly auth: SessionAuth;
  readonly channel: TurnChannel;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** The visible answer; for a child with an output schema, its structured result as JSON. */
  readonly finalText: string | null;
  /** The turn input (and anything after it) is already in the session history. */
  readonly historyStarted: boolean;
  readonly id: string;
  readonly input: TurnStartInput;
  readonly kind: TurnKind;
  readonly nextStepIndex: number;
  readonly parentCallId: string | null;
  readonly parentTurnId: string | null;
  /** Context lines that came with a partial answer; the continuation turn receives them. */
  readonly pendingContext: readonly string[];
  readonly prepared: PreparedTurn | null;
  /** The parked turn whose step this continuation settles before its own model calls. */
  readonly resumesTurnId: string | null;
  readonly runnerId: string | null;
  readonly sequence: number;
  readonly sessionId: string;
  readonly status: TurnStatus;
}

/**
 * - `awaiting_input`: waits for a person (approval or question);
 * - `planned`: decided to run, not started;
 * - `intent`: written just before running, so the action may have started;
 * - `completed`: the result for the model is recorded;
 * - `unknown`: the process died during an action with consequences; it is not repeated.
 */
/**
 * An `agent` call whose child turn waits for a person: the parent shows the child's requests and
 * routes the answers to the child session.
 */
export interface SubagentInputRequest {
  readonly childSessionId: string;
  readonly kind: "subagent";
  readonly requests: readonly InputRequest[];
}

export type ToolCallState = "awaiting_input" | "completed" | "intent" | "planned" | "unknown";

export interface ToolCallRecord {
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly inputRequest: InputRequest | SubagentInputRequest | null;
  readonly inputResponse: InputResponse | null;
  readonly output: ToolResultOutput | null;
  readonly position: number;
  readonly state: ToolCallState;
  readonly stepIndex: number;
  readonly toolName: string;
}

export interface TurnStepRecord {
  readonly completed: boolean;
  readonly finishReason: string;
  /** The assistant message(s) of the step as AI SDK returned them. */
  readonly response: ModelMessage[];
  readonly stepIndex: number;
  /** The step's text already went to the channel. */
  readonly textEmitted: boolean;
}
