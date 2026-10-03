/**
 * The built-in `read_file` tool: numbered lines of a text file in the sandbox.
 *
 * Exports:
 * - `readFile`: the built-in definition the model sees as `read_file`.
 * - `executeReadFileOnSandbox`, `ReadFileInput`, `ReadFileResult`: the execution; a successful read
 *   records the file's stamp so `write_file` may overwrite it.
 *
 * The sandbox and the stamp store come from the tool context.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import { resolveAbsoluteFilePath } from "../sandbox/paths.js";
import type { SandboxSession } from "../sandbox/types.js";
import type { SessionToolState } from "../session/tool-state.js";
import { defineTool } from "../tool.js";
import { createReadFileStamp, normalizeModelPath } from "./file-state.js";
import { capLineLength, MAX_OUTPUT_BYTES } from "./truncate-output.js";

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;

export const READ_FILE_INPUT_SCHEMA = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to read. A leading $HOME is supported."),
  limit: z.number().int().min(1).describe("Maximum number of lines to return. Defaults to 2000.").optional(),
  offset: z.number().int().min(1).describe("1-based line number to start from. Defaults to 1.").optional(),
});

export type ReadFileInput = z.infer<typeof READ_FILE_INPUT_SCHEMA>;

export interface ReadFileResult {
  readonly content: string;
  readonly nextOffset?: number;
  readonly path: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export async function executeReadFileOnSandbox(
  sandbox: Pick<SandboxSession, "readTextFile" | "run">,
  state: Pick<SessionToolState, "writeFileStamp">,
  args: ReadFileInput,
): Promise<ReadFileResult> {
  const { filePath, offset, limit } = args;
  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const normalizedPath = normalizeModelPath(resolvedPath);
  const effectiveOffset = offset ?? DEFAULT_OFFSET;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  if (effectiveOffset < 1) throw new Error(`offset must be >= 1. Received: ${effectiveOffset}.`);

  const rawContent = await sandbox.readTextFile({ path: resolvedPath });
  if (rawContent === null) {
    throw new Error(`File not found: ${filePath}. Verify the path exists and is accessible in the sandbox.`);
  }
  if (rawContent.includes("\0")) {
    throw new Error(`File "${filePath}" contains NUL bytes and appears to be a binary file. read_file only supports text files.`);
  }

  // A trailing newline does not open another line: a file ending with \n has N lines.
  const allLines = rawContent.split("\n");
  const totalLines = allLines.length > 0 && allLines[allLines.length - 1] === "" ? allLines.length - 1 : allLines.length;
  if (totalLines === 0) {
    if (effectiveOffset > 1) {
      throw new Error(`offset ${effectiveOffset} is past the end of the file (0 lines). Use the default offset to read an empty file.`);
    }
  } else if (effectiveOffset > totalLines) {
    throw new Error(`offset ${effectiveOffset} is past the end of the file (${totalLines} lines).`);
  }

  // After every check that can throw: a failed read never authorizes a write.
  await state.writeFileStamp(normalizedPath, createReadFileStamp({ content: rawContent, filePath: normalizedPath }));
  if (totalLines === 0) return { content: "", path: normalizedPath, totalLines: 0, truncated: false };

  const startIndex = effectiveOffset - 1;
  const selectedLines = allLines.slice(startIndex, Math.min(startIndex + effectiveLimit, totalLines));
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;
  for (const [index, line] of selectedLines.entries()) {
    const numbered = `${effectiveOffset + index}: ${capLineLength(line)}`;
    const lineBytes = Buffer.byteLength(numbered, "utf8") + 1;
    if (outputBytes + lineBytes > MAX_OUTPUT_BYTES && outputLines.length > 0) {
      truncatedByBytes = true;
      break;
    }
    outputLines.push(numbered);
    outputBytes += lineBytes;
  }

  const content = outputLines.join("\n");
  const lastLineReturned = effectiveOffset + outputLines.length - 1;
  if (lastLineReturned < totalLines || truncatedByBytes) {
    return { content, nextOffset: lastLineReturned + 1, path: normalizedPath, totalLines, truncated: true };
  }
  return { content, path: normalizedPath, totalLines, truncated: false };
}

export const readFile = defineTool({
  description: [
    "Read a file from the local filesystem. If the path does not exist, an error is returned.",
    "",
    "Usage:",
    "- The filePath parameter should be an absolute path or begin with $HOME/.",
    "- By default, this tool returns up to 2000 lines from the start of the file.",
    "- The offset parameter is the line number to start from (1-indexed).",
    "- To read later sections, call this tool again with a larger offset.",
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".',
    "- Any line longer than 2000 characters is truncated.",
    "- Call this tool in parallel when you know there are multiple files you want to read.",
    "- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeReadFileOnSandbox(await ctx.getSandbox(), ctx.state, input);
  },
  inputSchema: READ_FILE_INPUT_SCHEMA,
  replaySafe: true,
});
