/**
 * The bounded process that runs a media tool (FFmpeg, ffprobe) on a file a chat participant sent.
 *
 * Exports:
 * - `MEDIA_TOOL_INPUT_FD`: the descriptor the tool reads its input file from.
 * - `runMediaTool`: the tool's standard output, or an `AppError` with a stable code.
 *
 * Key constructs:
 * - The file is untrusted, and a decoder is where a crafted file attacks. The tool therefore gets an
 *   environment of `PATH` alone, so the agent's secrets never reach it, and in the image (a root or
 *   production agent) it runs inside `media-sandbox` (services/media-sandbox/), as `nobody` under
 *   root: Landlock leaves it no file but its own program and the system libraries, and no TCP;
 *   seccomp no socket, no socket ioctl and no process of its own. A decoder taken over reads no
 *   family's files, reaches none of the container's networks and leaves nothing running. The input
 *   arrives as an open descriptor and the output leaves through the descriptors Node opened, which
 *   stay usable. A development machine runs the tool as its own user, without the sandbox.
 * - The sandbox reports its own failure on a descriptor of its own (4), closed before the tool
 *   starts: a line the tool writes can never pass for the sandbox's.
 * - A time limit and an output limit kill a tool that hangs or floods; its error output is kept only
 *   as a short tail for the log.
 * - A tool that is missing or cannot start is a broken installation, not a bad file: its codes
 *   (`AGENT_MEDIA_TOOL_MISSING`, `AGENT_MEDIA_TOOL_START_FAILED`) are told apart from a tool that ran
 *   and failed on the file; so is a sandbox that cannot restrict the tool
 *   (`AGENT_MEDIA_TOOL_SANDBOX_UNAVAILABLE`): the tool then never runs unrestricted.
 */
import { type ChildProcess, spawn } from "node:child_process";

import { AppError } from "../app-error.js";

export const MEDIA_TOOL_INPUT_FD = 3;

const NOBODY_ID = 65_534;
// The image's own build of services/media-sandbox/media-sandbox.c, beside its FFmpeg.
const MEDIA_SANDBOX_BINARY = "/usr/local/bin/media-sandbox";
// media-sandbox's own exits, each with one line `media-sandbox: STEP: MESSAGE (ERRNO_NAME)` on its
// status descriptor.
const SANDBOX_TOOL_NOT_STARTED = 126;
const SANDBOX_TOOL_NOT_FOUND = 127;
const SANDBOX_STATUS_PATTERN = /^media-sandbox: .*\(([A-Z0-9]+)\)$/mu;
const SANDBOX_STATUS_MAX_CHARACTERS = 1_000;
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

interface Launch {
  readonly args: readonly string[];
  readonly command: string;
  readonly identity: { gid: number; uid: number } | Record<string, never>;
  readonly sandboxed: boolean;
}

/**
 * In the image the tool runs inside the sandbox, as nobody under root. The sandbox needs no root, so
 * a production agent that ever ran as another user would still run it; only a development machine
 * runs the tool as itself.
 */
function launchOf(run: MediaToolRun): Launch {
  const root = process.getuid?.() === 0;
  if (!root && process.env.NODE_ENV !== "production") {
    return { args: run.args, command: run.binary, identity: {}, sandboxed: false };
  }
  return {
    args: [run.binary, ...run.args],
    command: MEDIA_SANDBOX_BINARY,
    identity: root ? { gid: NOBODY_ID, uid: NOBODY_ID } : {},
    sandboxed: true,
  };
}

function missing(binary: string, cause?: unknown): AppError {
  return new AppError("AGENT_MEDIA_TOOL_MISSING", "На сервере нет программы для обработки медиафайлов", {
    ...(cause === undefined ? {} : { cause }),
    details: { binary },
  });
}

/** What the sandbox reported on its own descriptor: it never started the tool, and why. */
function sandboxFailure(binary: string, exitCode: number | null, status: string): AppError {
  const errno = SANDBOX_STATUS_PATTERN.exec(status)?.[1] ?? "unknown";
  if (exitCode === SANDBOX_TOOL_NOT_FOUND) return missing(binary);
  if (exitCode === SANDBOX_TOOL_NOT_STARTED) {
    return new AppError("AGENT_MEDIA_TOOL_START_FAILED", "Не удалось запустить программу обработки медиафайлов", {
      details: { binary, errno },
    });
  }
  return new AppError("AGENT_MEDIA_TOOL_SANDBOX_UNAVAILABLE", "Не удалось изолировать программу обработки медиафайлов", {
    details: { binary, errno, exitCode: exitCode ?? -1, status: status.trim() },
  });
}

export async function runMediaTool(run: MediaToolRun): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const launch = launchOf(run);
    let child: ChildProcess;
    try {
      const input = run.inputFd === undefined ? [] : [run.inputFd];
      child = spawn(launch.command, [...launch.args], {
        env: { PATH: MEDIA_TOOL_PATH },
        // The sandbox's status descriptor is the fifth; the input, if any, stays the fourth.
        stdio: launch.sandboxed
          ? ["ignore", "pipe", "pipe", run.inputFd ?? "ignore", "pipe"]
          : ["ignore", "pipe", "pipe", ...input],
        ...launch.identity,
      });
    } catch (error) {
      // Node throws at once for a start failure it does not report as an event, such as EPERM.
      reject(startFailed(run.binary, error));
      return;
    }
    // `stdio` above makes both pipes; the typing loses that once a fourth descriptor is listed.
    const stdout = child.stdout!;
    const stderrStream = child.stderr!;
    const statusStream = launch.sandboxed ? child.stdio[4] as NodeJS.ReadableStream & { destroy(): void } : null;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let status = "";
    let failure: AppError | null = null;
    const stop = (error: AppError) => {
      failure ??= error;
      child.kill("SIGKILL");
      // A descendant holding the output open must not keep the agent waiting for `close`.
      stdout.destroy();
      stderrStream.destroy();
      statusStream?.destroy();
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
    statusStream?.on("error", streamFailed);
    statusStream?.on("data", (chunk: Buffer) => {
      status = `${status}${chunk.toString("utf8")}`.slice(0, SANDBOX_STATUS_MAX_CHARACTERS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? missing(launch.command, error) : startFailed(launch.command, error));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (failure !== null) {
        reject(failure);
        return;
      }
      if (exitCode !== 0) {
        if (status.length > 0) {
          reject(sandboxFailure(run.binary, exitCode, status));
          return;
        }
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
