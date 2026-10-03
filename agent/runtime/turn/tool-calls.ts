/**
 * One tool call from a model step: its input, its approval decision and its execution.
 *
 * Exports:
 * - `resolveToolCallInput`: the call input as an object, or the error text the model reads.
 * - `decideToolApproval`: execute now, ask a person, or deny — from the tool's own policy.
 * - `executeToolCall`: runs the tool and returns the result as the model will see it; a failure
 *   becomes `error-text`, a cancelled turn throws.
 *
 * The runtime executes the call itself after the model call; outputs and error texts are the
 * values AI SDK 7.0.60 produces (`createToolModelOutput`).
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { JSONValue } from "@ai-sdk/provider";
import type { ToolResultPart } from "ai";

import { isObject, parseJsonObject } from "../json.js";
import type { ApprovalStatus, ToolContext, ToolDefinition, ToolModelOutput } from "../tool.js";
import { TurnCancelledError } from "./model-errors.js";

export type ToolResultOutput = ToolResultPart["output"];

export type ToolApprovalDecision =
  | { readonly kind: "execute" }
  | { readonly kind: "ask" }
  | { readonly kind: "deny"; readonly reason: string | undefined };

// The surface holds tools of different input types; only the runtime contract matters here.
type AnyToolDefinition = ToolDefinition<any, any>;

function errorText(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.toString();
  return JSON.stringify(error);
}

export function resolveToolCallInput(call: {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}): { readonly input: Record<string, unknown> } | { readonly error: string } {
  if (call.input === undefined || call.input === null) return { input: {} };
  if (typeof call.input === "string" && call.input.trim() === "") return { input: {} };
  try {
    return { input: parseJsonObject(typeof call.input === "string" ? JSON.parse(call.input) : call.input) as Record<string, unknown> };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse tool-call arguments for "${call.toolName}" (${call.toolCallId}): ${detail}` };
  }
}

export async function decideToolApproval(
  definition: AnyToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolApprovalDecision> {
  if (definition.approval === undefined) return { kind: "execute" };
  const status: ApprovalStatus = await definition.approval({
    approvedTools: new Set(),
    callId: ctx.callId,
    getSandbox: ctx.getSandbox,
    session: ctx.session,
    toolInput: isObject(input) ? input : undefined,
    toolName: ctx.toolName,
  });
  const normalized = typeof status === "boolean" ? (status ? "user-approval" : "not-applicable") : status;
  const type = typeof normalized === "object" ? normalized.type : normalized;
  if (type === "user-approval") return { kind: "ask" };
  if (type === "denied") return { kind: "deny", reason: typeof normalized === "object" ? normalized.reason : undefined };
  return { kind: "execute" };
}

// AI SDK's JSON type is mutable; the value is checked here and never mutated afterwards.
function requireJson(value: unknown): JSONValue {
  const candidate = value === undefined ? null : value;
  parseJsonObject({ value: candidate });
  return candidate as JSONValue;
}

function requireModelOutput(output: ToolModelOutput): ToolResultOutput {
  if (output.type === "text" && typeof output.value === "string") return output;
  if (output.type === "json") return { type: "json", value: requireJson(output.value) };
  if (output.type === "content" && Array.isArray(output.value) && output.value.length > 0 &&
    output.value.every((part) => part.type === "text" ? typeof part.text === "string"
      : part.type === "file" && part.data?.type === "data" && typeof part.data.data === "string" && part.mediaType.length > 0)) {
    return output as ToolResultOutput;
  }
  throw new TypeError("Expected toModelOutput to return a text, json or content result.");
}

function logFailure(error: unknown, ctx: ToolContext): void {
  // A coded refusal the tool boundary already reported must not raise the unstructured-error alert.
  if (error instanceof Error && error.name === "ModelFacingError" && (error as { isExpectedRefusal?: unknown }).isExpectedRefusal === true) return;
  const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
  console.error(JSON.stringify({
    code: "AGENT_TOOL_EXECUTION_FAILED",
    error: error instanceof Error ? error.message : String(error),
    ...(code === undefined ? {} : { errorCode: code }),
    sessionId: ctx.session.id,
    toolCallId: ctx.callId,
    toolName: ctx.toolName,
    turnId: ctx.session.turn.id,
  }));
}

// A streaming tool yields preliminary results; as in AI SDK, the last one is the result.
async function lastOutput(output: unknown): Promise<unknown> {
  const value = await output;
  if (!isObject(value) || typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] !== "function") return value;
  let last: unknown;
  for await (const item of value as unknown as AsyncIterable<unknown>) last = item;
  return last;
}

export async function executeToolCall(
  definition: AnyToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResultOutput> {
  try {
    const output = await lastOutput(definition.execute(input, ctx));
    if (definition.toModelOutput !== undefined) return requireModelOutput(await definition.toModelOutput(output));
    if (typeof output === "string") return { type: "text", value: output };
    return { type: "json", value: requireJson(output) };
  } catch (error) {
    if (ctx.abortSignal.aborted) throw new TurnCancelledError({ cause: error });
    logFailure(error, ctx);
    return { type: "error-text", value: errorText(error) };
  }
}
