/**
 * Bounded privileged subprocess runner.
 *
 * Exports:
 * - `SAFE_HOST_PATH`: the only command search path host commands run with.
 * - `runHostCommand`: runs one exact executable and returns bounded stdout or redacted diagnostics.
 */
import { spawn } from "node:child_process";

import { InstallerError } from "./errors.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const DIAGNOSTIC_EDGE_BYTES = MAX_DIAGNOSTIC_BYTES / 2;
export const SAFE_HOST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function redactDiagnosticSecrets(value: string): string {
  return value
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?))\s*=\s*([^\s]+)/giu,
      "$1=[СКРЫТО]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s]+/giu, "$1 [СКРЫТО]")
    .replace(/:\/\/([^\s:/]+):([^\s@/]+)@/gu, "://$1:[СКРЫТО]@");
}

function boundedStderrDiagnostic(stderr: readonly Buffer[]): string | null {
  const bytes = Buffer.concat(stderr);
  if (bytes.byteLength === 0) return null;

  // Preserve both command startup context and the terminal failure while bounding disclosure.
  const selected = bytes.byteLength <= MAX_DIAGNOSTIC_BYTES
    ? bytes
    : Buffer.concat([
        bytes.subarray(0, DIAGNOSTIC_EDGE_BYTES),
        Buffer.from("\n...[диагностика сокращена]...\n", "utf8"),
        bytes.subarray(-DIAGNOSTIC_EDGE_BYTES),
      ]);
  const sanitized = redactDiagnosticSecrets(selected.toString("utf8")).trim();
  return sanitized || null;
}

export async function runHostCommand(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: Buffer;
  readonly timeoutMs: number;
}): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      // Ambient Compose and application variables must never override validated --env-file values.
      env: input.env ?? { PATH: SAFE_HOST_PATH },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new InstallerError(
        "OSINARA_INSTALL_HOST_COMMAND_FAILED",
        `Не удалось запустить обязательную команду ${input.command}`,
        { cause: error },
      ));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut || outputBytes > MAX_OUTPUT_BYTES || code !== 0) {
        const diagnostic = boundedStderrDiagnostic(stderr);
        const reason = timedOut
          ? "превысила допустимое время выполнения"
          : outputBytes > MAX_OUTPUT_BYTES
            ? "превысила допустимый объём вывода"
            : `завершилась с кодом ${code ?? "unknown"}`;
        reject(new InstallerError(
          "OSINARA_INSTALL_HOST_COMMAND_FAILED",
          `Команда ${input.command} ${reason}.${diagnostic ? ` stderr: ${diagnostic}` : " Проверьте системный журнал"}`,
          { cause: new Error(`exit=${code ?? "null"} signal=${signal ?? "none"}`) },
        ));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    if (input.stdin) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}
