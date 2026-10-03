/**
 * Requests that wait for a person, and what the model reads once they are answered.
 *
 * Exports:
 * - `ASK_QUESTION_TOOL_NAME`: the built-in tool whose call parks for a person's answer.
 * - `approvalRequest`, `questionRequest`: the request a parked call shows to the person.
 * - `renderPendingApprovalsNote`: the note written into history while approvals wait.
 * - `resolveApprovalOutcome`, `deniedOutput`, `questionOutput`: the tool result the model reads.
 * - `stepInputResolved`: whether the answers given so far release the parked step.
 *
 * Derived from eve 0.40.0 `harness/input-extraction.ts`, `harness/hitl/approval-prompt.ts`,
 * `harness/input-request-resolution.ts`, `harness/hitl/approval-input-requests.ts` and
 * `harness/hitl/question-input-requests.ts` (Apache-2.0, see NOTICE-eve). Changes: one parked step
 * is one batch, so the batch rules apply to the step's calls; the texts are verbatim, and the
 * recorded Eve requests pin the note and the denial result.
 */
import { createIdGenerator } from "ai";

import type { ToolResultOutput } from "../turn/tool-calls.js";
import type { InputOption, InputRequest, InputResponse } from "./types.js";

export const ASK_QUESTION_TOOL_NAME = "ask_question";
export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";
const INVALID_APPROVAL_MESSAGE = "Invalid approval response.";
const PENDING_APPROVALS_LABEL = "[Pending approvals]";

// AI SDK 7 generates approval ids this way; transferred histories already carry such ids.
const createApprovalId = createIdGenerator({ prefix: "aitxt", size: 24 });

interface ParkedCall {
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly toolName: string;
}

export function approvalRequest(call: ParkedCall, requestId: string = createApprovalId()): InputRequest {
  return {
    action: { callId: call.callId, input: call.input, kind: "tool-call", toolName: call.toolName },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
    prompt: `Approve tool call: ${call.toolName}`,
    requestId,
  };
}

export function questionRequest(call: ParkedCall): InputRequest {
  const options = call.input.options as readonly InputOption[] | undefined;
  return {
    action: { callId: call.callId, input: call.input, kind: "tool-call", toolName: call.toolName },
    ...(call.input.allowFreeform === undefined ? {} : { allowFreeform: call.input.allowFreeform as boolean }),
    display: options === undefined ? "text" : "select",
    kind: "question",
    ...(options === undefined ? {} : { options }),
    prompt: String(call.input.prompt),
    requestId: call.callId,
  };
}

export function renderPendingApprovalsNote(requests: readonly InputRequest[]): string | undefined {
  const approvals = requests.filter((request) => request.kind === "tool-approval");
  if (approvals.length === 0) return undefined;
  return [
    PENDING_APPROVALS_LABEL,
    "The following tool calls are awaiting approval and have not executed:",
    ...approvals.map((request) => JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName })),
  ].join("\n");
}

export function resolveApprovalOutcome(response: InputResponse | undefined): {
  readonly approved: boolean;
  readonly reason: string | undefined;
} {
  if (response === undefined) return { approved: false, reason: IGNORED_INPUT_REASON };
  if (response.optionId === "approve") return { approved: true, reason: undefined };
  if (response.optionId === "cancel" || response.optionId === "deny") {
    return { approved: false, reason: TOOL_EXECUTION_DENIED_MESSAGE };
  }
  return { approved: false, reason: INVALID_APPROVAL_MESSAGE };
}

export function deniedOutput(reason: string | undefined): ToolResultOutput {
  return reason === undefined ? { type: "execution-denied" } : { type: "execution-denied", reason };
}

export function questionOutput(response: InputResponse | undefined): ToolResultOutput {
  if (response === undefined) return { type: "json", value: { status: "ignored" } };
  // JSON drops an absent field, exactly as Eve's stored results did.
  return {
    type: "json",
    value: {
      ...(response.optionId === undefined ? {} : { optionId: response.optionId }),
      ...(response.text === undefined ? {} : { text: response.text }),
      status: "answered",
    },
  };
}

/**
 * A step with an approval waits for an answer to every approval; questions answered by then are
 * read, the rest are ignored. A question-only step continues on the first answer.
 */
export function stepInputResolved(requests: readonly InputRequest[], responses: ReadonlyMap<string, InputResponse>): boolean {
  const approvals = requests.filter((request) => request.kind === "tool-approval");
  if (approvals.length > 0) return approvals.every((request) => responses.has(request.requestId));
  return requests.some((request) => responses.has(request.requestId));
}
