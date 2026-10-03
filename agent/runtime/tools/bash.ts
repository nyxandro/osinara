/**
 * The built-in `bash` tool: one shell command in the session's sandbox.
 *
 * Exports:
 * - `bash`: the built-in definition the model sees as `bash`.
 * - `defineBashTool`: the same execution under an application-chosen description.
 * - `executeBashOnSandbox`, `BashInput`, `BashResult`: the execution, with stdout and stderr
 *   bounded from their tails.
 *
 * Derived from eve 0.40.0 `runtime/framework-tools/bash.ts`, `execution/sandbox/bash-tool.ts`
 * and `public/tools/define-bash-tool.ts` (Apache-2.0, see NOTICE-eve). Changes: the sandbox comes
 * from the tool context; Eve's development-mode progress logging is gone.
 */
import { z } from "zod";

import type { SandboxSession } from "../sandbox/types.js";
import { defineTool, type ToolDefinition } from "../tool.js";
import { truncateTail } from "./truncate-output.js";

export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
});

export type BashInput = z.infer<typeof BASH_INPUT_SCHEMA>;

export interface BashResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  /** True when stdout or stderr was shortened to fit within output limits. */
  readonly truncated: boolean;
}

export async function executeBashOnSandbox(sandbox: Pick<SandboxSession, "run">, args: BashInput): Promise<BashResult> {
  const raw = await sandbox.run({ command: args.command });
  const stdoutResult = truncateTail(raw.stdout);
  const stderrResult = truncateTail(raw.stderr);
  const stdout = stdoutResult.truncated
    ? `[stdout truncated: showing last ${stdoutResult.outputLines} of ${stdoutResult.totalLines} lines]\n${stdoutResult.output}`
    : stdoutResult.output;
  const stderr = stderrResult.truncated
    ? `[stderr truncated: showing last ${stderrResult.outputLines} of ${stderrResult.totalLines} lines]\n${stderrResult.output}`
    : stderrResult.output;
  return { exitCode: raw.exitCode, stderr, stdout, truncated: stdoutResult.truncated || stderrResult.truncated };
}

export function defineBashTool(input: { readonly description?: string } = {}): ToolDefinition<BashInput, BashResult> {
  return defineTool({
    description: input.description ?? "Execute a shell command in the workspace sandbox.",
    async execute(args: BashInput, ctx) {
      return await executeBashOnSandbox(await ctx.getSandbox(), args);
    },
    inputSchema: BASH_INPUT_SCHEMA,
  });
}

export const bash = defineBashTool({ description: "Execute a shell command in the shared workspace environment." });
