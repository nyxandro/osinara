/**
 * Recorder of the language-model requests Eve composes in reference scenarios.
 *
 * Export:
 * - `recordReferenceModelRequest`: stores one model call of a reference scenario verbatim.
 *
 * The request is stored as `json`, not `jsonb`, because key order is part of what the provider
 * receives: the property order of a tool input schema reaches the model unchanged.
 */
import { database } from "../../../../agent/lib/database.js";
import { referenceRequestIdentity, type ReferenceTextMessage } from "./reference-scenarios.js";

interface ModelCallParams {
  readonly prompt: ReadonlyArray<{ readonly content: unknown; readonly role: string }>;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { text?: unknown; type?: unknown }) =>
      (part.type === "text" || part.type === "reasoning") && typeof part.text === "string" ? part.text : "")
    .join("");
}

function promptTexts(params: ModelCallParams): ReferenceTextMessage[] {
  return params.prompt.map((message) => ({ role: message.role, text: messageText(message.content) }));
}

export async function recordReferenceModelRequest(
  kind: "generate" | "stream",
  params: ModelCallParams,
): Promise<void> {
  const identity = referenceRequestIdentity(promptTexts(params));
  if (identity === null) return;
  // The abort signal is a live handle of this call, not request content.
  const request = JSON.stringify(params, (key, value: unknown) => key === "abortSignal" ? undefined : value);
  await database().query(
    `INSERT INTO telegram_conversation_test_model_requests (scenario, child, call_kind, request)
     VALUES ($1, $2, $3, $4::json)`,
    [identity.scenario, identity.child, kind, request],
  );
}
