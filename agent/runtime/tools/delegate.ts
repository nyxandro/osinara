/**
 * The built-in `agent` tool: a focused subtask for a fresh copy of the agent.
 *
 * Exports:
 * - `agentTool`, `AGENT_TOOL_NAME`: the definition the model sees as `agent`. The runtime runs its
 *   call as a child turn (`turn/child-turns.ts`); `execute` is never reached.
 * - `formatSubagentMessage`: the child turn's first message.
 * - `requestedOutputSchema`: the call's `outputSchema`, only when it is a non-empty object.
 * - `finalOutputTool`, `FINAL_OUTPUT_TOOL_NAME`: the tool a child with an output schema answers through.
 *
 * Ported from eve 0.40.0 `runtime/framework-tools/agent.ts`, `runtime/subagents/registry.ts`
 * (input schema), `execution/subagent-invocation.ts` and `runtime/framework-tools/final-output.ts`
 * (Apache-2.0, see NOTICE-eve). The input schema is the JSON Eve sent, verbatim, so the provider
 * sees the same tool.
 */
import type { JsonObject } from "../json.js";
import { defineTool, type ToolDefinition } from "../tool.js";

export const AGENT_TOOL_NAME = "agent";
export const FINAL_OUTPUT_TOOL_NAME = "final_output";

const AGENT_TOOL_INPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    },
    outputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
      description: "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The subagent must match a provided schema, and that structured output becomes the tool result.",
    },
  },
  required: ["message"],
  additionalProperties: false,
} satisfies JsonObject;

export const agentTool: ToolDefinition<{ readonly message: string; readonly outputSchema?: JsonObject }, unknown> = defineTool({
  description: [
    "Delegate a focused subtask to a fresh copy of yourself.",
    "Use it to isolate complex work or split a large task into independent pieces.",
    "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
    "Each child has fresh history and state but shares your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
  ].join(" "),
  async execute(): Promise<unknown> {
    throw new Error("AGENT_DELEGATION_EXECUTED: the runtime runs an agent call as a child turn");
  },
  inputSchema: AGENT_TOOL_INPUT_SCHEMA,
  runtimeAction: "subagent",
});

export function formatSubagentMessage(message: string): string {
  return [
    `You are the subagent "${AGENT_TOOL_NAME}".`,
    "",
    "The caller delegated the following task to you. Complete it and return the final result directly.",
    "",
    "Caller message:",
    message,
  ].join("\n");
}

/** Models often send an empty `{}`; it constrains nothing and must not switch the child to structured output. */
export function requestedOutputSchema(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? value as JsonObject
    : undefined;
}

export function finalOutputTool(schema: JsonObject): ToolDefinition<unknown, unknown> {
  return defineTool({
    description: "Deliver your final answer in the required structure by calling this tool. Call it exactly once, when you are done; do not answer in prose.",
    async execute(): Promise<unknown> {
      throw new Error("AGENT_FINAL_OUTPUT_EXECUTED: final_output ends the child turn; it never executes");
    },
    inputSchema: schema,
  });
}
