/**
 * Moves the turn memory payload out of the cached instruction prefix.
 *
 * Export:
 * - `projectTurnMemory`: returns a prompt where the payload rides in the turn tail.
 *
 * Key constructs:
 * - Retrieved memory changes every turn. Left in the prefix it invalidates the provider's reuse of
 *   the whole conversation, so the turn waits for a full recompute before its first token.
 * - Records are untrusted data and belong in the conversation, not among the instructions.
 * - The anchor is the last user message, not the end of the prompt: a turn appends assistant and
 *   tool messages across its steps, and an anchor placed after them would move on every step,
 *   costing the within-turn reuse this projection also has to preserve.
 * - Anything the markers do not delimit — the core rules, the mode block, a memory service notice —
 *   stays exactly where it was.
 *
 * Why not Eve's own `defineInstructions({ role: "user" })`, which lands in the same position: Eve
 * drains such a message into `session.history`, so every turn's selection would stay there and
 * accumulate. This payload has to be gone by the next turn, which leaves the transport boundary as
 * the only place to express it.
 *
 * The anchor assumes the last user message is the one this turn is answering. Today that holds
 * because every path that lacks such a message also lacks a payload: an approval continuation
 * retrieves none (`memory-retrieval.ts`), a memory-review session resolves none
 * (`instructions/retrieved-memory.ts`), and a scheduled run delivers an ordinary user message. A
 * recovery note Eve appends after the turn message does move the anchor past it, which costs one
 * miss on a path that is already an exception.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

import { TURN_MEMORY_CLOSE_TAG, TURN_MEMORY_OPEN_TAG } from "./turn-memory-context.js";

interface ExtractedPayload {
  readonly payload: string;
  readonly remainingPrefix: string;
}

/** A marker delimits the payload only when it opens its own line, never inside a sentence. */
function findLineAnchored(content: string, marker: string, from: number): number {
  for (let at = content.indexOf(marker, from); at !== -1; at = content.indexOf(marker, at + marker.length)) {
    if (at === 0 || content[at - 1] === "\n") return at;
  }
  return -1;
}

/**
 * Cuts the delimited payload out of one merged system message. Eve joins every system instruction
 * with a blank line, so the separator left behind is removed with it.
 *
 * The core rules name both markers in prose to explain the block to the model, and records are
 * escaped before they are serialized. Only a marker on its own line is therefore a boundary:
 * matching an inline mention would cut every section between it and the real block out of the
 * prefix.
 *
 * Returns `null` when this message carries no complete payload; an unterminated marker is left
 * untouched rather than guessed at, because a wrong boundary would silently drop instructions.
 */
function extractPayload(content: string): ExtractedPayload | null {
  const start = findLineAnchored(content, TURN_MEMORY_OPEN_TAG, 0);
  if (start === -1) return null;
  const closeAt = findLineAnchored(
    content, TURN_MEMORY_CLOSE_TAG, start + TURN_MEMORY_OPEN_TAG.length,
  );
  if (closeAt === -1) return null;

  const end = closeAt + TURN_MEMORY_CLOSE_TAG.length;
  const before = content.slice(0, start).replace(/\s+$/u, "");
  const after = content.slice(end).replace(/^\s+/u, "");
  const remainingPrefix = before.length > 0 && after.length > 0
    ? `${before}\n\n${after}`
    : `${before}${after}`;
  return { payload: content.slice(start, end), remainingPrefix };
}

function lastUserMessageIndex(prompt: LanguageModelV4Prompt): number {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]!.role === "user") return index;
  }
  return -1;
}

export function projectTurnMemory(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const sourceIndex = prompt.findIndex(
    (message) => message.role === "system" && extractPayload(message.content) !== null,
  );
  if (sourceIndex === -1) return prompt;

  // Without a user message there is no turn tail to anchor to, and moving the payload behind an
  // assistant message would present it as something the agent itself said.
  const anchorIndex = lastUserMessageIndex(prompt);
  if (anchorIndex === -1) return prompt;

  const source = prompt[sourceIndex] as Extract<LanguageModelV4Prompt[number], { role: "system" }>;
  const { payload, remainingPrefix } = extractPayload(source.content)!;

  const projected: LanguageModelV4Prompt = [];
  for (const [index, message] of prompt.entries()) {
    if (index === anchorIndex) {
      projected.push({ role: "user", content: [{ type: "text", text: payload }] });
    }
    if (index !== sourceIndex) {
      projected.push(message);
      continue;
    }
    // An instruction message that held nothing but the payload has no remaining purpose. Its
    // provider options go with it: the only ones this harness sets are Anthropic cache markers,
    // and the Anthropic path never reaches this projection.
    if (remainingPrefix.length > 0) projected.push({ ...source, content: remainingPrefix });
  }
  return projected;
}
