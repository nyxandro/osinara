/**
 * Application tool contract: definition, execution context and approval policy.
 *
 * Exports:
 * - `defineTool`: types a tool definition from its input schema; the runtime reads it as is.
 * - `ToolDefinition`, `ToolContext`: what a tool declares and what its `execute` receives.
 * - `ToolModelOutput`: what the model sees instead of the full result, when a tool projects it.
 * - `ApprovalContext`, `ApprovalStatus`: what an approval policy sees and decides per call.
 *
 * Definitions are plain objects. `ApprovalStatus` keeps AI SDK 7's values (`"user-approval"`,
 * `"not-applicable"`, `"approved"`, `"denied"`), which the runtime passes to AI SDK unchanged.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { JsonObject } from "./json.js";
import type { SessionContext } from "./context.js";
import type { SessionToolState } from "./session/tool-state.js";
import type { InferStandardOutput, StandardJSONSchemaV1, StandardSchemaV1 } from "./standard-schema.js";

export type ToolInputSchema<TInput = unknown> =
  | StandardSchemaV1<unknown, TInput>
  | StandardJSONSchemaV1<unknown, TInput>
  | JsonObject;

export type ToolModelOutputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly data: { readonly type: "data"; readonly data: string };
      readonly mediaType: string;
      readonly filename?: string;
    };

export type ToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "content"; readonly value: readonly ToolModelOutputPart[] };

export type ToolContext = SessionContext & {
  /** Aborts when the turn is cancelled. */
  readonly abortSignal: AbortSignal;
  /** Id of this tool call; stable across a replay after a crash, so it keys exactly-once barriers. */
  readonly callId: string;
  /** Names of the skills listed to the model in this turn; `load_skill` loads only these. */
  readonly skills: readonly string[];
  /** Session state of the built-in tools (todo list, read-before-write stamps). */
  readonly state: SessionToolState;
  readonly toolName: string;
};

type ApprovalToolInput<TInput> = TInput extends object ? Readonly<TInput> : TInput;
type ApprovalContextInput<TInput> = unknown extends TInput ? Record<string, unknown> : TInput;

export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
  readonly approvedTools: ReadonlySet<string>;
  readonly callId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

export type ApprovalStatus =
  | undefined
  | boolean
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | { readonly type: "not-applicable"; readonly reason?: never }
  | { readonly type: "approved"; readonly reason?: string }
  | { readonly type: "denied"; readonly reason?: string }
  | { readonly type: "user-approval"; readonly reason?: never };

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly description: string;
  inputSchema: ToolInputSchema<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput> | TOutput | AsyncIterable<TOutput>;
  /**
   * Decides per call whether a person must confirm it before it runs. A method, so a policy typed
   * for this tool's input still fits a mixed tool map: the runtime only calls it with that input.
   */
  approval?(ctx: ApprovalContext<ApprovalContextInput<TInput>>): ApprovalStatus | Promise<ApprovalStatus>;
  /**
   * Repeating the call after a crash cannot repeat a consequence: the tool only reads, or it keys
   * its effect on `callId`. Any other call interrupted by a crash is reported to the model as an
   * unknown outcome instead of being run again.
   */
  readonly replaySafe?: boolean;
  /** Marks the runtime's `agent` tool: its call runs as a child turn instead of `execute`. */
  readonly runtimeAction?: "subagent";
  /** Projects the full result into what the model sees; channel handlers still get the full result. */
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

type ToolOutputFromExecuteReturn<TReturn> =
  TReturn extends Promise<infer TOutput>
    ? TOutput
    : TReturn extends AsyncIterable<infer TOutput>
      ? TOutput
      : TReturn;

type ToolDefinitionWithExecuteReturn<TInput, TOutput, TReturn> = ToolDefinition<TInput, TOutput> & {
  execute(input: TInput, ctx: ToolContext): TReturn;
};

type SchemaInput<TSchema extends StandardSchemaV1 | StandardJSONSchemaV1> = InferStandardOutput<TSchema>;

export function defineTool<TSchema extends StandardSchemaV1 | StandardJSONSchemaV1, TReturn>(definition: {
  description: string;
  inputSchema: TSchema;
  execute(input: SchemaInput<TSchema>, ctx: ToolContext): TReturn;
  approval?: ToolDefinition<SchemaInput<TSchema>, unknown>["approval"];
  replaySafe?: boolean;
  runtimeAction?: "subagent";
  toModelOutput?: ToolDefinition<unknown, ToolOutputFromExecuteReturn<TReturn>>["toModelOutput"];
}): ToolDefinitionWithExecuteReturn<SchemaInput<TSchema>, ToolOutputFromExecuteReturn<TReturn>, TReturn>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return definition;
}
