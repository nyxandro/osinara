/**
 * The built-in `write_file` tool: whole-file writes guarded by read-before-write.
 *
 * Exports:
 * - `writeFile`: the built-in definition the model sees as `write_file`.
 * - `executeWriteFileOnSandbox`, `WriteFileInput`, `WriteFileResult`: the execution. An existing
 *   file is overwritten only after `read_file` saw its current content.
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

export const WRITE_FILE_INPUT_SCHEMA = z.strictObject({
  content: z.string().describe("Complete replacement file contents."),
  filePath: z.string().describe("The absolute path to the file to write. A leading $HOME is supported."),
});

export type WriteFileInput = z.infer<typeof WRITE_FILE_INPUT_SCHEMA>;

export interface WriteFileResult {
  readonly existed: boolean;
  readonly path: string;
}

export async function executeWriteFileOnSandbox(
  sandbox: Pick<SandboxSession, "readTextFile" | "run" | "writeTextFile">,
  state: Pick<SessionToolState, "readFileStamp" | "writeFileStamp">,
  args: WriteFileInput,
): Promise<WriteFileResult> {
  const { filePath, content } = args;
  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const normalizedPath = normalizeModelPath(resolvedPath);
  // Stale-write detection hashes the current content, so even a new file is read first.
  const currentContent = await sandbox.readTextFile({ path: resolvedPath });
  if (currentContent === null) {
    await sandbox.writeTextFile({ content, path: resolvedPath });
    await state.writeFileStamp(normalizedPath, createReadFileStamp({ content, filePath: normalizedPath }));
    return { existed: false, path: normalizedPath };
  }

  const storedStamp = await state.readFileStamp(normalizedPath);
  if (storedStamp === undefined) {
    throw new Error(`You must read file ${filePath} before overwriting it. Use the read_file tool first.`);
  }
  const currentStamp = createReadFileStamp({ content: currentContent, filePath: normalizedPath });
  if (currentStamp.contentHash !== storedStamp.contentHash || currentStamp.byteLength !== storedStamp.byteLength) {
    throw new Error(`File ${filePath} has been modified since it was last read. Please read the file again before modifying it.`);
  }

  await sandbox.writeTextFile({ content, path: resolvedPath });
  await state.writeFileStamp(normalizedPath, createReadFileStamp({ content, filePath: normalizedPath }));
  return { existed: true, path: normalizedPath };
}

export const writeFile = defineTool({
  description: [
    "Writes a file to the local filesystem.",
    "",
    "Usage:",
    "- This tool will overwrite the existing file if there is one at the provided path.",
    "- If this is an existing file, you MUST use the read_file tool first to read the file's contents. This tool will fail if you did not read the file first.",
    "- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
    "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
    "- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeWriteFileOnSandbox(await ctx.getSandbox(), ctx.state, input);
  },
  inputSchema: WRITE_FILE_INPUT_SCHEMA,
});
