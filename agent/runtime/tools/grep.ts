/**
 * The built-in `grep` tool: lines matching a pattern in sandbox files.
 *
 * Exports:
 * - `grep`: the built-in definition the model sees as `grep`.
 * - `executeGrepOnSandbox`, `GrepInput`, `GrepResult`: ripgrep, or POSIX grep.
 *
 * The sandbox comes from the tool context.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import { resolveAbsoluteFilePath } from "../sandbox/paths.js";
import type { SandboxSession } from "../sandbox/types.js";
import { defineTool } from "../tool.js";
import { normalizeModelPath } from "./file-state.js";
import { ripgrepIsAvailable } from "./ripgrep-probe.js";
import { shellQuote } from "./shell-quote.js";
import { capLineLength, MAX_OUTPUT_BYTES } from "./truncate-output.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 1000;
const DEFAULT_PATH = "/workspace";

// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeGrepOnSandbox}.
 */
export interface GrepInput {
  readonly context?: number;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  readonly literal?: boolean;
  readonly path?: string;
  readonly pattern: string;
}

/**
 * Structured result returned from {@link executeGrepOnSandbox}.
 */
export interface GrepResult {
  readonly content: string;
  readonly matchCount: number;
  readonly path: string;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Searches file contents for a pattern inside the sandbox.
 */
export async function executeGrepOnSandbox(
  sandbox: Pick<SandboxSession, "id" | "run">,
  args: GrepInput,
): Promise<GrepResult> {
  const effectivePath = args.path ?? DEFAULT_PATH;

  const resolvedPath = await resolveAbsoluteFilePath(sandbox, effectivePath);
  const normalizedPath = normalizeModelPath(resolvedPath);
  const effectiveLimit = Math.min(Math.max(1, args.limit ?? DEFAULT_GREP_LIMIT), MAX_GREP_LIMIT);
  const contextLines = args.context !== undefined && args.context > 0 ? args.context : 0;

  const command = (await ripgrepIsAvailable(sandbox))
    ? buildRipgrepCommand({
        contextLines,
        effectiveLimit,
        glob: args.glob,
        ignoreCase: args.ignoreCase ?? false,
        literal: args.literal ?? false,
        normalizedPath,
        pattern: args.pattern,
      })
    : buildPosixGrepCommand({
        contextLines,
        effectiveLimit,
        glob: args.glob,
        ignoreCase: args.ignoreCase ?? false,
        literal: args.literal ?? false,
        normalizedPath,
        pattern: args.pattern,
      });

  const result = await sandbox.run({ command });

  // Both ripgrep and POSIX grep use the same conventional exit codes:
  //   0 — one or more matches were found
  //   1 — no matches found (legitimate empty result)
  //   2 — error occurred (e.g. regex compile failure, IO error)
  // Any other exit code (e.g. 127 from bash when the tool is missing)
  // indicates a real failure. Surface these as structured errors
  // rather than silently pretending the search returned zero matches.
  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    (result.exitCode === 1 && result.stderr.trim().length > 0)
  ) {
    throw buildGrepExecutionError(command, result.exitCode, result.stderr);
  }

  const stdout = result.stdout;

  if (stdout.trim().length === 0) {
    return {
      content: "No matches found",
      matchCount: 0,
      path: normalizedPath,
      truncated: false,
    };
  }

  return processOutput({ effectiveLimit, normalizedPath, stdout });
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

interface BuildCommandInput {
  readonly contextLines: number;
  readonly effectiveLimit: number;
  readonly glob: string | undefined;
  readonly ignoreCase: boolean;
  readonly literal: boolean;
  readonly normalizedPath: string;
  readonly pattern: string;
}

/**
 * Builds the ripgrep form of the grep command. Preferred whenever
 * `rg` is on PATH — ripgrep respects `.gitignore` out of the box,
 * handles hidden-file semantics cleanly, and is substantially faster
 * than GNU grep on large repositories.
 *
 * `--no-messages` is intentionally *not* passed — we want ripgrep's
 * error messages to flow through stderr so callers can distinguish a
 * real failure (missing binary, unreadable path) from a legitimate
 * empty result.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  const parts: string[] = ["rg", "--line-number", "--color=never", "--hidden", "--glob '!.git/*'"];

  if (input.ignoreCase) {
    parts.push("--ignore-case");
  }

  if (input.literal) {
    parts.push("--fixed-strings");
  }

  if (input.glob !== undefined) {
    parts.push(`--glob ${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`--context ${input.contextLines}`);
  }

  // `--max-count` limits matches per file; we use it to bound total output.
  parts.push(`--max-count ${input.effectiveLimit}`);
  parts.push("--");
  parts.push(shellQuote(input.pattern));
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

/**
 * Builds the POSIX fallback form of the grep command using `grep -rn`.
 */
function buildPosixGrepCommand(input: BuildCommandInput): string {
  const parts: string[] = ["grep", "-r", "-n", "--exclude-dir=.git"];

  if (input.ignoreCase) {
    parts.push("-i");
  }

  if (input.literal) {
    parts.push("-F");
  } else {
    // Default to ERE so the pattern semantics line up with ripgrep's
    // default (which uses a Rust regex dialect close to ERE).
    parts.push("-E");
  }

  if (input.glob !== undefined) {
    parts.push(`--include=${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`-C ${input.contextLines}`);
  }

  // `-m` limits matches per file, analogous to ripgrep's `--max-count`.
  parts.push(`-m ${input.effectiveLimit}`);
  parts.push(`-e ${shellQuote(input.pattern)}`);
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

interface ProcessOutputInput {
  readonly effectiveLimit: number;
  readonly normalizedPath: string;
  readonly stdout: string;
}

function processOutput(input: ProcessOutputInput): GrepResult {
  // Process output: truncate long lines, cap total bytes.
  const rawLines = input.stdout.split("\n");
  const outputLines: string[] = [];
  let outputBytes = 0;
  let matchCount = 0;
  let truncatedByBytes = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";

    // Skip empty trailing line from split.
    if (rawLine.length === 0 && index === rawLines.length - 1) {
      continue;
    }

    // Count match lines (not context separators like `--`).
    if (rawLine !== "--" && rawLine.length > 0) {
      // Match lines from both rg and POSIX grep have format `file:linenum:text`.
      // Context lines use `file-linenum-text` (rg) or `file-linenum-text` (grep).
      const isMatchLine = /^.+:\d+:/.test(rawLine);
      if (isMatchLine) {
        matchCount++;
      }
    }

    const line = capLineLength(rawLine);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for \n

    if (outputBytes + lineBytes > MAX_OUTPUT_BYTES && outputLines.length > 0) {
      truncatedByBytes = true;
      break;
    }

    outputLines.push(line);
    outputBytes += lineBytes;
  }

  const truncated = truncatedByBytes || matchCount >= input.effectiveLimit;

  let content = outputLines.join("\n");

  if (truncated) {
    const notices: string[] = [];
    if (matchCount >= input.effectiveLimit) {
      notices.push(
        `Match limit reached (${input.effectiveLimit}). Use a larger limit or more specific pattern.`,
      );
    }
    if (truncatedByBytes) {
      notices.push("Output truncated due to size. Use a more specific path or pattern.");
    }
    content += `\n\n[${notices.join(" ")}]`;
  }

  return {
    content,
    matchCount,
    path: input.normalizedPath,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function buildGrepExecutionError(command: string, exitCode: number, stderr: string): Error {
  const trimmed = stderr.trim();
  const detail = trimmed.length > 0 ? trimmed : "no stderr output";
  return new Error(`grep failed (exit ${exitCode}): ${detail}\nCommand: ${command}`);
}

export const GREP_INPUT_SCHEMA = z.strictObject({
  context: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of surrounding context lines to include before and after each match. Defaults to 0.",
    )
    .optional(),
  glob: z.string().describe('Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}").').optional(),
  ignoreCase: z
    .boolean()
    .describe("Perform case-insensitive search. Defaults to false.")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("Maximum number of matches to return per file. Defaults to 100.")
    .optional(),
  literal: z
    .boolean()
    .describe(
      "Treat the pattern as a literal string instead of a regular expression. Defaults to false.",
    )
    .optional(),
  path: z
    .string()
    .describe(
      "The directory or file to search in. Defaults to /workspace. " +
        "Must be an absolute path or begin with $HOME/. Omit to use the default.",
    )
    .optional(),
  pattern: z
    .string()
    .describe(
      'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").',
    ),
});

/**
 * Shared output schema used by the framework `grep` tool and any author tool
 * constructed via {@link defineGrepTool}.
 */

export const grep = defineTool({
  description: [
    "Fast content search tool that works with any codebase size.",
    "",
    "Usage:",
    "- Searches file contents using regular expressions.",
    '- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").',
    '- Filter files by pattern with the glob parameter (e.g. "*.js", "*.{ts,tsx}").',
    "- Returns matching lines with file paths and line numbers.",
    "- Call this tool in parallel when you have multiple independent searches.",
    "- Any line longer than 2000 characters is truncated.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeGrepOnSandbox(await ctx.getSandbox(), input);
  },
  inputSchema: GREP_INPUT_SCHEMA,
  replaySafe: true,
});
