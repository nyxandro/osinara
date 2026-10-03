/**
 * The tool set one model step advertises.
 *
 * Exports:
 * - `BUILT_IN_TOOL_ORDER`: the fixed place of the runtime's built-in tools.
 * - `orderStepTools`: built-ins first, then static tools, then `agent`, then the application
 *   surface in its own order. A fixed order keeps the provider's cached prompt prefix valid.
 * - `toModelToolSet`: model-facing AI SDK definitions without `execute`: the runtime executes tool
 *   calls itself after the model call returns.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { asSchema, jsonSchema, tool, type ToolSet } from "ai";

import type { JsonObject } from "../json.js";
import type { ToolDefinition, ToolInputSchema } from "../tool.js";

export const BUILT_IN_TOOL_ORDER = [
  "ask_question", "bash", "read_file", "write_file", "todo", "web_fetch", "load_skill",
] as const;
const DELEGATION_TOOL_NAME = "agent";

// The surface maps hold tools of different input types; the runtime never relies on them here.
type AnyToolDefinition = ToolDefinition<any, any>;

export function orderStepTools(
  tools: Readonly<Record<string, AnyToolDefinition>>,
  staticToolNames: readonly string[] = [],
): Array<[string, AnyToolDefinition]> {
  const leading = [...BUILT_IN_TOOL_ORDER, ...staticToolNames, DELEGATION_TOOL_NAME];
  const placed = leading.filter((name) => Object.hasOwn(tools, name));
  const rest = Object.keys(tools).filter((name) => !leading.includes(name));
  return [...placed, ...rest].map((name) => [name, tools[name]!]);
}

function isStandardSchema(schema: ToolInputSchema): boolean {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

export function toModelToolSet(tools: ReadonlyArray<readonly [string, AnyToolDefinition]>): ToolSet {
  return Object.fromEntries(tools.map(([name, definition]) => {
    const inputSchema = isStandardSchema(definition.inputSchema)
      ? asSchema(definition.inputSchema as Parameters<typeof asSchema>[0])
      : jsonSchema(definition.inputSchema as JsonObject);
    return [name, tool({ description: definition.description, inputSchema })];
  }));
}
