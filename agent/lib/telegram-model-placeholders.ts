/**
 * Texts the Telegram boundary puts into the model's message in place of words a person did not write.
 *
 * Exports:
 * - `CAPTIONLESS_ATTACHMENT_MODEL_TEXT`: what the model reads for a file sent without a caption.
 * - `apiKeyDeliveredModelText`: what the model reads in place of an API key the owner sent: the key
 *   arrived, whether it works, and that the task waiting for it goes on.
 * - `withoutApiKeyDeliveredModelText`: a memory query without that notice, keeping the owner's own
 *   words that joined it in one burst.
 * - `isApiKeyDeliveredModelText`: whether a memory query is that notice and nothing else.
 *
 * Shared with memory so that the placeholder is recognised as no question at all: from 2026-10-09
 * to 2026-10-16 memory was searched by it twice and brought eight unrelated records each time.
 */
export const CAPTIONLESS_ATTACHMENT_MODEL_TEXT = "Пользователь отправил файл без подписи.";

// The notice stands where the owner's message was, so it opens by saying whose words it is. It
// names no silence marker: in a private chat that line is named only by tool results.
const API_KEY_DELIVERED_PREFIX = "[Application notice in place of the owner's message]";
const API_KEY_APPLIED_ENDING = "If nothing waits for the key, one short line to the owner is enough.";
const API_KEY_NOT_APPLIED_ENDING = "then continue the task you requested it for.";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// One notice, with either ending. A notice is one line and its ending occurs only at its end.
const API_KEY_DELIVERED_PATTERN = new RegExp(
  `${escapeRegExp(API_KEY_DELIVERED_PREFIX)}.*?(?:${escapeRegExp(API_KEY_APPLIED_ENDING)}|${escapeRegExp(API_KEY_NOT_APPLIED_ENDING)})`,
  "gu",
);

export function apiKeyDeliveredModelText(input: {
  /** The key was applied to the sandbox egress proxy and already works in the owner's chat. */
  readonly applied: boolean;
  readonly name: string;
  readonly variables: { readonly apiKey: string; readonly baseUrl: string };
}): string {
  const stored = `${API_KEY_DELIVERED_PREFIX} The owner sent the API key "${input.name}" you requested. ` +
    "The application stored it encrypted and removes the owner's message from the chat, so that message takes no reaction; you never see the key.";
  if (input.applied) {
    return `${stored} It already works in this private chat through ${input.variables.apiKey} and ${input.variables.baseUrl}. ` +
      `Continue the task you requested it for. ${API_KEY_APPLIED_ENDING}`;
  }
  return `${stored} Applying it failed (AGENT_API_KEY_PUBLISH_FAILED), so it does not work yet: grant it again ` +
    `with name=${input.name} and target=personal to apply it, ${API_KEY_NOT_APPLIED_ENDING}`;
}

export function withoutApiKeyDeliveredModelText(text: string): string {
  return text.replace(API_KEY_DELIVERED_PATTERN, " ");
}

/** Takes the text after `prepareMemoryQuery`, which returns a notice alone as it was. */
export function isApiKeyDeliveredModelText(prepared: string): boolean {
  const rest = withoutApiKeyDeliveredModelText(prepared);
  return rest !== prepared && rest.trim() === "";
}
