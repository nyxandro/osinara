/**
 * The system prompt of one model step.
 *
 * Exports:
 * - `composeBasePrompt`: the session's fixed part — authored instructions plus the parallel-tool rule.
 * - `composeSystemPrompt`: base, then this turn's system blocks, then the skill list, one message.
 *
 * The empty-delivery marker is taught by the application prompt in every mode. The texts are
 * pinned by the reference requests in `testing/reference-requests/`.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nA single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, the runtime treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.";

const BLOCK_SEPARATOR = "\n\n";

export function composeBasePrompt(input: {
  readonly instructions: { readonly content: string; readonly name: string };
  readonly toolsAvailable: boolean;
}): string {
  const blocks = [`Instructions (${input.instructions.name})\n${input.instructions.content.trim()}`];
  if (input.toolsAvailable) blocks.push(PARALLEL_ACTION_INSTRUCTION);
  return blocks.join(BLOCK_SEPARATOR);
}

export function composeSystemPrompt(input: {
  readonly base: string;
  readonly instructionBlocks: readonly string[];
  readonly skillsSection: string | null;
}): string {
  return [input.base, ...input.instructionBlocks, ...(input.skillsSection === null ? [] : [input.skillsSection])]
    .join(BLOCK_SEPARATOR);
}
