/**
 * Answers that arrive as text, or for a request that no longer waits.
 *
 * Exports:
 * - `resolveTextToResponses`: a text message as the answer to waiting requests — an option by id,
 *   label or number, or free text where the request allows it.
 * - `staleResponsesMessage`: the user message the model reads for an answer to a request that was
 *   already answered or dismissed; it never authorizes an earlier action.
 *
 * Ported from eve 0.40.0 `channel/resolve-text.ts` and `harness/stale-input-responses.ts`
 * (`formatModelMessage`) (Apache-2.0, see NOTICE-eve). The texts are verbatim: transferred
 * histories already contain them.
 */
import type { InputOption, InputRequest, InputResponse } from "./types.js";

function matchOption(normalized: string, options: readonly InputOption[]): InputOption | undefined {
  const byId = options.find((option) => option.id.toLowerCase() === normalized);
  if (byId !== undefined) return byId;
  const byLabel = options.find((option) => option.label.toLowerCase() === normalized);
  if (byLabel !== undefined) return byLabel;
  const numericIndex = Number(normalized);
  if (Number.isInteger(numericIndex) && numericIndex > 0 && numericIndex <= options.length) return options[numericIndex - 1];
  return undefined;
}

function resolveTextToResponse(text: string, request: InputRequest): InputResponse | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (request.options !== undefined && request.options.length > 0) {
    const matched = matchOption(trimmed.toLowerCase(), request.options);
    if (matched !== undefined) return { optionId: matched.id, requestId: request.requestId };
  }
  const acceptsFreeform = request.allowFreeform === true || request.options === undefined || request.options.length === 0;
  return acceptsFreeform ? { requestId: request.requestId, text: trimmed } : undefined;
}

export function resolveTextToResponses(text: string, requests: readonly InputRequest[]): InputResponse[] {
  return requests.flatMap((request) => {
    const response = resolveTextToResponse(text, request);
    return response === undefined ? [] : [response];
  });
}

export function staleResponsesMessage(responses: readonly InputResponse[], requests: ReadonlyMap<string, InputRequest>): string {
  const resolved = responses.map((response) => {
    const request = requests.get(response.requestId);
    const option = request?.options?.find((candidate) => candidate.id === response.optionId);
    const details: { optionId?: string; selectedOption?: { description?: string; id: string; label: string }; text?: string } = {};
    if (response.optionId !== undefined) details.optionId = response.optionId;
    if (option !== undefined) {
      details.selectedOption = { id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) };
    }
    if (response.text !== undefined) details.text = response.text;
    // Key order as Eve wrote it: the model reads this JSON verbatim.
    return {
      requestId: response.requestId,
      response: details,
      ...(request === undefined ? {} : { prompt: request.prompt, requestType: request.kind === "tool-approval" ? "approval" : "question" }),
    };
  });
  // Without the request's metadata the answer may still be an approval, so the notice stays.
  const mayIncludeApproval = responses.some((response) => {
    const request = requests.get(response.requestId);
    return request === undefined || request.kind === "tool-approval";
  });
  const approvalNotice = mayIncludeApproval
    ? " This does not authorize an earlier action; request approval again if that action is still needed."
    : "";
  return [
    "The user submitted the following response to an earlier interactive prompt.",
    `Treat it as new input at the current point in the conversation and decide whether it is still relevant.${approvalNotice}`,
    JSON.stringify(resolved, null, 2),
  ].join("\n");
}
