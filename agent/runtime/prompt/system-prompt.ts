/**
 * The system prompt of one model step.
 *
 * Exports:
 * - `composeBasePrompt`: the session's fixed part — authored instructions plus the parallel-tool rule.
 * - `composeSystemPrompt`: base, then this turn's system blocks, then the skill list, one message.
 *
 * Derived from eve 0.40.0 `runtime/prompt/compose.ts` and the system assembly of
 * `harness/tool-loop.ts` (`prepareModelCallInput`, `mergeSystemInstructions`) (Apache-2.0, see
 * NOTICE-eve). Changes: only the parts Osinara uses. There is no workspace overview (the agent
 * mounts no authored files), no subagent messaging block (persistent subagent sessions are off),
 * no connections, and no conditional-delivery block: Osinara's scheduled runs are not schedule-app
 * sessions, and the empty-delivery marker is taught by the application prompt in every mode.
 * The texts are verbatim; the recorded Eve requests in `testing/eve-0.40-requests/` pin them.
 */
export const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nA single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.";

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
