/**
 * The bounded process that runs a media tool (FFmpeg, ffprobe) on a file a chat participant sent.
 *
 * Exports:
 * - `MEDIA_TOOL_INPUT_FD`: the descriptor the tool reads its input file from.
 * - `runMediaTool`: the tool's standard output, or an `AppError` with a stable code.
 *
 * Key constructs:
 * - The file is untrusted, and a decoder is where a crafted file attacks. The tool therefore gets an
 *   environment of `PATH` alone, so the agent's secrets never reach it, and under a root agent it
 *   runs as `nobody`, which cannot read the agent's own process or its root-only files. The input
 *   arrives as an open descriptor, so the file itself stays readable by root alone.
 * - A time limit and an output limit kill a tool that hangs or floods; its error output is kept only
 *   as a short tail for the log.
 * - A tool that is missing or cannot start is a broken installation, not a bad file: its codes
 *   (`AGENT_MEDIA_TOOL_MISSING`, `AGENT_MEDIA_TOOL_START_FAILED`) are told apart from a tool that ran
 *   and failed on the file.
 */
import { type ChildProcess, spawn } from "node:child_process";

import { AppError } from "../app-error.js";

export const MEDIA_TOOL_INPUT_FD = 3;

const NOBODY_ID = 65_534;
// The image puts its own FFmpeg build in /usr/local/bin; a development machine has its system one.
const MEDIA_TOOL_PATH = "/usr/local/bin:/usr/bin:/bin";
const STDERR_TAIL_CHARACTERS = 2_000;

export interface MediaToolRun {
  readonly args: readonly string[];
  readonly binary: string;
  /** An open descriptor of the input file, handed to the tool as `MEDIA_TOOL_INPUT_FD`. */
  readonly inputFd?: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

function startFailed(binary: string, error: unknown): AppError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return new AppError("AGENT_MEDIA_TOOL_START_FAILED", "Не удалось запустить программу обработки медиафайлов", {
    cause: error,
    details: { binary, errno: errno ?? "unknown" },
  });
}

function unprivilegedIdentity(): { gid: number; uid: number } | Record<string, never> {
  return process.getuid?.() === 0 ? { gid: NOBODY_ID, uid: NOBODY_ID } : {};
}

export async function runMediaTool(run: MediaToolRun): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(run.binary, [...run.args], {
        env: { PATH: MEDIA_TOOL_PATH },
        stdio: ["ignore", "pipe", "pipe", ...(run.inputFd === undefined ? [] : [run.inputFd])],
        ...unprivilegedIdentity(),
      });
    } catch (error) {
      // Node throws at once for a start failure it does not report as an event, such as EPERM.
      reject(startFailed(run.binary, error));
      return;
    }
    // `stdio` above makes both pipes; the typing loses that once a fourth descriptor is listed.
    const stdout = child.stdout!;
    const stderrStream = child.stderr!;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let failure: AppError | null = null;
    const stop = (error: AppError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new AppError(
      "AGENT_MEDIA_TOOL_TIMEOUT",
      "Обработка медиафайла заняла слишком много времени",
      { details: { binary: run.binary, timeoutMs: run.timeoutMs } },
    )), run.timeoutMs);
    const streamFailed = (error: Error) => stop(new AppError(
      "AGENT_MEDIA_TOOL_FAILED",
      "Не удалось обработать медиафайл",
      { cause: error, details: { binary: run.binary } },
    ));

    stdout.on("error", streamFailed);
    stderrStream.on("error", streamFailed);
    stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > run.maxOutputBytes) {
        stop(new AppError(
          "AGENT_MEDIA_TOOL_OUTPUT_TOO_LARGE",
          "Результат обработки медиафайла оказался слишком большим",
          { details: { binary: run.binary, maxOutputBytes: run.maxOutputBytes } },
        ));
        return;
      }
      chunks.push(chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARACTERS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT"
        ? new AppError("AGENT_MEDIA_TOOL_MISSING", "На сервере нет программы для обработки медиафайлов", {
          cause: error,
          details: { binary: run.binary },
        })
        : startFailed(run.binary, error));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (failure !== null) {
        reject(failure);
        return;
      }
      if (exitCode !== 0) {
        reject(new AppError("AGENT_MEDIA_TOOL_FAILED", "Не удалось обработать медиафайл", {
          details: {
            binary: run.binary,
            exitCode: exitCode ?? -1,
            signal: signal ?? "none",
            stderr: stderr.trim(),
          },
        }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
