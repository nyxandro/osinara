/**
 * Moves the blocks that change from turn to turn out of the cached instruction prefix.
 *
 * Export:
 * - `projectTurnTail`: returns a prompt where the turn memory payload and the chat notes ride in
 *   the turn tail.
 *
 * Key constructs:
 * - Retrieved memory changes every turn, and the chat notes change whenever the agent tidies them.
 *   Left in the prefix, either invalidates the provider's reuse of the whole conversation, so the
 *   turn waits for a full recompute before its first token.
 * - Records are untrusted data and the notes are written from participants' words: both belong in
 *   the conversation, not among the instructions.
 * - The anchor is the last user message, not the end of the prompt: a turn appends assistant and
 *   tool messages across its steps, and an anchor placed after them would move on every step,
 *   costing the within-turn reuse this projection also has to preserve.
 * - Anything the markers do not delimit — the core rules, the mode block, a memory service notice —
 *   stays exactly where it was.
 *
 * Why not a user-role turn block (`userInstructions`), which lands in the same position: the
 * runtime writes such a message into the session history, so every turn's copy would stay there
 * and accumulate. These blocks have to be gone by the next turn, which leaves the transport
 * boundary as the only place to express it.
 *
 * The anchor assumes the last user message is the one this turn is answering. That holds for the
 * memory payload: every path that lacks such a message also lacks one — an approval continuation
 * retrieves none (`memory-retrieval.ts`), a memory-review session resolves none
 * (`instructions/retrieved-memory.ts`), and a scheduled run delivers an ordinary user message. The
 * notes of an approval continuation land before the last user message of the restored transcript,
 * which costs one miss on a rare path. A recovery note appended after the turn message would move
 * the anchor past it, which costs one miss on a path that is already an exception.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

import { CHAT_NOTES_CLOSE_TAG, CHAT_NOTES_OPEN_PREFIX } from "../behavior-preferences.js";
import { TURN_MEMORY_CLOSE_TAG, TURN_MEMORY_OPEN_TAG } from "./turn-memory-context.js";

interface ExtractedPayloads {
  /** The blocks in the order they stood in the prefix. */
  readonly payloads: readonly string[];
  readonly remainingPrefix: string;
}

/** Each block opens with a line that starts with `open` and ends with a line that starts with `close`. */
const TAIL_BLOCKS: ReadonlyArray<{ readonly close: string; readonly open: string }> = [
  { close: CHAT_NOTES_CLOSE_TAG, open: CHAT_NOTES_OPEN_PREFIX },
  { close: TURN_MEMORY_CLOSE_TAG, open: TURN_MEMORY_OPEN_TAG },
];

/** A marker delimits a block only when it opens its own line, never inside a sentence. */
function findLineAnchored(content: string, marker: string, from: number): number {
  for (let at = content.indexOf(marker, from); at !== -1; at = content.indexOf(marker, at + marker.length)) {
    if (at === 0 || content[at - 1] === "\n") return at;
  }
  return -1;
}

/**
 * Cuts the delimited blocks out of one merged system message. The runtime joins every system
 * instruction with a blank line (`runtime/prompt/system-prompt.ts`), so the separators left behind
 * are removed with them.
 *
 * The core rules name the markers in prose to explain the blocks to the model, and records and
 * notes are escaped before they are serialized. Only a marker on its own line is therefore a
 * boundary: matching an inline mention would cut every section between it and the real block out
 * of the prefix.
 *
 * Returns `null` when this message carries no complete block; an unterminated or tangled marker is
 * left untouched rather than guessed at, because a wrong boundary would silently drop instructions.
 */
function extractPayloads(content: string): ExtractedPayloads | null {
  const spans: Array<{ end: number; start: number }> = [];
  for (const block of TAIL_BLOCKS) {
    const start = findLineAnchored(content, block.open, 0);
    if (start === -1) continue;
    const closeAt = findLineAnchored(content, block.close, start + block.open.length);
    if (closeAt === -1) continue;
    spans.push({ end: closeAt + block.close.length, start });
  }
  if (spans.length === 0) return null;
  spans.sort((left, right) => left.start - right.start);
  if (spans.some((span, index) => index > 0 && span.start < spans[index - 1]!.end)) return null;

  const sections: string[] = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    const section = content.slice(cursor, span.start);
    sections.push(index === 0 ? section.replace(/\s+$/u, "") : section.trim());
    cursor = span.end;
  }
  sections.push(content.slice(cursor).replace(/^\s+/u, ""));
  return {
    payloads: spans.map((span) => content.slice(span.start, span.end)),
    remainingPrefix: sections.filter((section) => section.length > 0).join("\n\n"),
  };
}

function lastUserMessageIndex(prompt: LanguageModelV4Prompt): number {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]!.role === "user") return index;
  }
  return -1;
}

export function projectTurnTail(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const sourceIndex = prompt.findIndex(
    (message) => message.role === "system" && extractPayloads(message.content) !== null,
  );
  if (sourceIndex === -1) return prompt;

  // Without a user message there is no turn tail to anchor to, and moving the blocks behind an
  // assistant message would present them as something the agent itself said.
  const anchorIndex = lastUserMessageIndex(prompt);
  if (anchorIndex === -1) return prompt;

  const source = prompt[sourceIndex] as Extract<LanguageModelV4Prompt[number], { role: "system" }>;
  const { payloads, remainingPrefix } = extractPayloads(source.content)!;

  const projected: LanguageModelV4Prompt = [];
  for (const [index, message] of prompt.entries()) {
    if (index === anchorIndex) {
      for (const payload of payloads) {
        projected.push({ role: "user", content: [{ type: "text", text: payload }] });
      }
    }
    if (index !== sourceIndex) {
      projected.push(message);
      continue;
    }
    // An instruction message that held nothing but the blocks has no remaining purpose. Its
    // provider options go with it: the only ones this harness sets are Anthropic cache markers,
    // and the Anthropic path never reaches this projection.
    if (remainingPrefix.length > 0) projected.push({ ...source, content: remainingPrefix });
  }
  return projected;
}
