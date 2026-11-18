/**
 * One-shot credentialed Google Workspace container execution.
 *
 * Export:
 * - `executeGoogleWorkspaceContainer`: exact argv execution with isolated mounts and bounded output.
 */
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import type Docker from "dockerode";

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  type GoogleWorkspaceExecutionRequest,
  type SandboxRunnerProcessResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { classifyGoogleWorkspaceCommand } from "../../agent/lib/google-workspace/google-workspace-command-policy.js";
import { collectLimitedStream, type DestroyableStream } from "./docker-sandbox-files.js";
import {
  buildGoogleWorkspaceContainerOptions,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";

const PROCESS_KILL_GRACE_SECONDS = 5;

export async function executeGoogleWorkspaceContainer(input: {
  docker: Docker;
  request: GoogleWorkspaceExecutionRequest;
  runtime: SandboxDockerRuntime;
  signal?: AbortSignal;
}): Promise<SandboxRunnerProcessResponse> {
  // The privileged runner repeats application policy validation before accepting the live token.
  classifyGoogleWorkspaceCommand(input.request.argv);
  const options = buildGoogleWorkspaceContainerOptions(input.runtime, input.request);
  options.Cmd = [
    "timeout",
    "--signal=TERM",
    `--kill-after=${PROCESS_KILL_GRACE_SECONDS}s`,
    String(Math.max(1, Math.ceil(input.request.timeoutMs / 1_000))),
    ...(options.Cmd ?? []),
  ];
  options.name = `osinara-gws-${randomUUID()}`;
  const container = await input.docker.createContainer(options);
  let stream: (NodeJS.ReadWriteStream & DestroyableStream) | null = null;
  try {
    // docker-modem hands over the attached HTTP stream, a Node stream with `destroy` the types leave out.
    stream = await container.attach({ stream: true, stderr: true, stdout: true }) as NodeJS.ReadWriteStream & DestroyableStream;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("error", () => undefined);
    stderr.on("error", () => undefined);
    input.docker.modem.demuxStream(stream, stdout, stderr);
    stream.once("end", () => {
      stdout.end();
      stderr.end();
    });
    stream.once("error", (error) => {
      stdout.destroy(error);
      stderr.destroy(error);
    });

    await container.start();
    const aborted = new Promise<never>((_resolve, reject) => {
      if (input.signal?.aborted) return reject(input.signal.reason);
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    });
    const wait = container.wait();
    const [status, stdoutBytes, stderrBytes] = await Promise.race([
      Promise.all([
        wait,
        collectLimitedStream(stdout, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
        collectLimitedStream(stderr, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
      ]),
      aborted,
    ]);
    return {
      exitCode: status.StatusCode,
      processId: randomUUID(),
      stderr: stderrBytes.toString("utf8"),
      stdout: stdoutBytes.toString("utf8"),
    };
  } finally {
    stream?.destroy();
    // Credential-bearing compute is never durable, including cancellation and output-limit paths.
    await container.remove({ force: true, v: true });
  }
}
