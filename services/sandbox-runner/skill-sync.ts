import type Docker from "dockerode";
import { execFile } from "node:child_process";
import { parseSandboxWorkspaceId } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { sandboxContainerName, type SandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";
import type { SkillSyncRequest, SkillSyncResult } from "../../agent/lib/sandbox-runner/skill-sync-contract.js";
import { executeSandboxProcess } from "./docker-sandbox-process.js";
import { SKILL_SYNC_PROGRAM } from "./skill-sync-program.js";

export type SkillSyncLocation = { kind: "volume"; homeRoot: string } | { kind: "container" };
const SKILL_SYNC_TIMEOUT_MS = 60_000;

export async function syncSandboxSkills(
  input: { docker: Docker; activity: SandboxActivityRegistry; toolsRoot: string; toolsVolume: string; project: string },
  sessionId: string, request: SkillSyncRequest, signal?: AbortSignal,
): Promise<SkillSyncResult> {
  return input.activity.runExclusive(sessionId, () => input.activity.runActive(sessionId, async () => {
    signal?.throwIfAborted();
    const container = input.docker.getContainer(sandboxContainerName(sessionId));
    const inspect = async () => {
      const info = await container.inspect();
      if (info.Id !== request.expectedInstanceId || info.Config.Labels?.["dev.osinara.sandbox.session-id"] !== sessionId ||
          info.Config.Labels?.["dev.osinara.sandbox.project"] !== input.project) {
        throw new Error("AGENT_SANDBOX_RUNNER_INSTANCE_STALE: Skill synchronization targets an inactive container");
      }
      return info;
    };
    const info = await inspect();
    const toolMount = info.HostConfig.Mounts?.find(mount => mount.Target.startsWith("/tools/"));
    const subpath = (toolMount?.VolumeOptions as { Subpath?: string } | undefined)?.Subpath;
    const access = info.Config.Labels?.["dev.osinara.sandbox.access"];
    let location: SkillSyncLocation, lockKey: string;
    if (access === "restricted" && !toolMount) {
      location = { kind: "container" }; lockKey = `skills:container:${request.expectedInstanceId}`;
    } else if ((access === "trusted" || access === "group-tools") && toolMount &&
        toolMount.Type === "volume" && toolMount.Source === input.toolsVolume &&
        ["/tools/personal", "/tools/family", "/tools/group"].includes(toolMount.Target)) {
      const workspaceId = parseSandboxWorkspaceId(subpath);
      location = { kind: "volume", homeRoot: `${input.toolsRoot}/${workspaceId}/home` };
      lockKey = `skills:volume:${workspaceId}`;
    } else throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_SCOPE_INVALID: Container has no authorized skill location");
    return input.activity.runExclusive(lockKey, async () => {
      signal?.throwIfAborted();
      const current = await inspect();
      const selected = input.docker.getContainer(request.expectedInstanceId);
      if (!current.State.Running) await selected.start();
      return syncSkillFiles(input.docker, selected, request, location, signal);
    });
  }));
}

export async function syncSkillFiles(
  docker: Docker, container: Docker.Container, request: SkillSyncRequest,
  location: SkillSyncLocation, signal?: AbortSignal,
): Promise<SkillSyncResult> {
  signal?.throwIfAborted();
  const payload = Buffer.from(JSON.stringify(request));
  let stdout: string;
  if (location.kind === "volume") {
    // Never use the model container's PATH, Node binary or environment to verify writable tools.
    stdout = await new Promise<string>((resolve, reject) => {
      let outcome: { error: Error | null; output: string; stderr: string } | undefined;
      let inputError: Error | undefined;
      const child = execFile(process.execPath, ["-e", SKILL_SYNC_PROGRAM], {
        env: { HOME: location.homeRoot }, signal, timeout: SKILL_SYNC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      }, (error, output, stderr) => { outcome = { error, output, stderr }; });
      // Keep the session lock until the process really exits, including abort/error paths.
      child.once("close", () => {
        if (inputError) reject(inputError);
        else if (!outcome) reject(new Error("AGENT_SANDBOX_RUNNER_SKILLS_RESPONSE_INVALID: Synchronization process closed without a result"));
        else if (outcome.error) reject(new Error(`AGENT_SANDBOX_RUNNER_SKILLS_SYNC_FAILED: Trusted synchronization process failed. ${outcome.stderr.trim()}`, { cause: outcome.error }));
        else resolve(outcome.output);
      });
      if (!child.stdin) { inputError = new Error("AGENT_SANDBOX_RUNNER_SKILLS_STDIN_MISSING: Synchronization input pipe is unavailable"); child.kill("SIGKILL"); return; }
      child.stdin.once("error", error => { inputError = new Error("AGENT_SANDBOX_RUNNER_SKILLS_INPUT_FAILED: Cannot send the synchronization manifest", { cause: error }); child.kill("SIGKILL"); });
      child.stdin.end(payload);
    });
  } else {
    // Restricted compute has no authored Bash and no writable tools mount. Its image-owned
    // interpreter is trusted; its HOME is tmpfs and only accessible inside this pinned container.
    const result = await executeSandboxProcess(docker, container, {
      command: "/usr/local/bin/node -e '" + SKILL_SYNC_PROGRAM.replaceAll("'", "'\\''") + "'",
      stdin: payload, timeoutMs: SKILL_SYNC_TIMEOUT_MS,
    }, signal);
    if (result.exitCode !== 0) throw new Error(`AGENT_SANDBOX_RUNNER_SKILLS_SYNC_FAILED: ${result.stderr}`);
    stdout = result.stdout;
  }
  let value: SkillSyncResult;
  try { value = JSON.parse(stdout); }
  catch (cause) { throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_RESPONSE_INVALID: Invalid synchronization result", { cause }); }
  const expectedFiles = request.packages.reduce((count, pkg) => count + pkg.files.length, 0);
  if (!value || ![value.checked, value.written, value.removed].every(count => Number.isSafeInteger(count) && count >= 0) ||
      value.checked !== expectedFiles || value.written > value.checked) {
    throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_RESPONSE_INVALID: Missing synchronization result");
  }
  return value;
}
