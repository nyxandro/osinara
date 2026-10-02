/**
 * The sandbox runner's engine for the end-to-end test: local folders and `bash` instead of Docker.
 *
 * Export:
 * - `createSandboxEngineDouble`: a `SandboxEngine` behind the real runner HTTP server
 *   (`services/sandbox-runner/server.ts`), so the application's own sandbox code — mounts, stored
 *   state, skill sync, the runner client — runs unchanged. Each session is a folder whose `/` is the
 *   sandbox root; commands run with `bash` in its `/workspace` with `HOME=/home/agent`.
 *
 * Journaled: every created session with its mounts (`e2e_sandbox_sessions`) and every command
 * (`e2e_sandbox_processes`). A command naming `e2e-block` never finishes, as if the process had
 * been killed under it; one naming `e2e-hold:<marker>` waits until the test releases the marker.
 *
 * Test-only.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import type { Pool } from "pg";

import type { SandboxEngine } from "../../services/sandbox-runner/sandbox-engine.js";
import { E2E_TABLES } from "./e2e-tables.js";

const run = promisify(execFile);
const SANDBOX_HOME = "/home/agent";
const SKILL_ROOT = `${SANDBOX_HOME}/.agents/skills`;
const HOLD_POLL_MILLISECONDS = 100;

export function createSandboxEngineDouble(input: { readonly db: Pick<Pool, "query">; readonly root: string }): SandboxEngine {
  const sessionRoot = (sessionId: string) => join(input.root, sessionId.replace(/[^A-Za-z0-9_-]/gu, "_"));
  const real = (sessionId: string, path: string) => {
    if (!path.startsWith("/") || path.split("/").includes("..")) throw new Error(`TEST_SANDBOX_PATH_INVALID: ${path}`);
    return join(sessionRoot(sessionId), path);
  };

  async function hold(command: string): Promise<void> {
    if (command.includes("e2e-block")) await new Promise<never>(() => {});
    const held = /e2e-hold:([A-Za-z0-9-]+)/u.exec(command)?.[1];
    if (held === undefined) return;
    while ((await input.db.query(`SELECT 1 FROM ${E2E_TABLES.releases} WHERE marker = $1`, [held])).rowCount !== 1) {
      await sleep(HOLD_POLL_MILLISECONDS);
    }
  }

  return {
    async createSession(request) {
      await mkdir(real(request.sandboxSessionId, "/workspace"), { recursive: true });
      await mkdir(real(request.sandboxSessionId, SANDBOX_HOME), { recursive: true });
      await input.db.query(
        `INSERT INTO ${E2E_TABLES.sandboxSessions} (sandbox_session_id, access, mounts) VALUES ($1, $2, $3)`,
        [request.sandboxSessionId, request.access, JSON.stringify(request.mounts)],
      );
      const instanceId = createHash("sha256").update(request.sandboxSessionId).digest("hex");
      return { created: true, instanceId, seedRequired: false, sessionId: request.sandboxSessionId };
    },
    async deleteToolEnvironment() {},
    async health() {},
    async readFile(sessionId, path) {
      try {
        return new Uint8Array(await readFile(real(sessionId, path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async reconcileIdleSessions() { return { removed: 0, stopped: 0 }; },
    async removePath(sessionId, request) {
      await rm(real(sessionId, request.path), { force: request.force === true, recursive: request.recursive === true });
    },
    async runGoogleWorkspace() { throw new Error("TEST_GOOGLE_WORKSPACE_UNAVAILABLE"); },
    async runProcess(sessionId, request) {
      const logged = (await input.db.query<{ id: number }>(
        `INSERT INTO ${E2E_TABLES.sandboxProcesses} (sandbox_session_id, command) VALUES ($1, $2) RETURNING id`,
        [sessionId, request.command],
      )).rows[0]!;
      await hold(request.command);
      const result = await run("bash", ["-c", request.command], {
        cwd: real(sessionId, "/workspace"),
        env: { ...request.environment, HOME: SANDBOX_HOME, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }).then(({ stderr, stdout }) => ({ exitCode: 0, stderr, stdout }), (error: { code?: number; stderr?: string; stdout?: string }) => ({
        exitCode: typeof error.code === "number" ? error.code : 1, stderr: error.stderr ?? "", stdout: error.stdout ?? "",
      }));
      await input.db.query(`UPDATE ${E2E_TABLES.sandboxProcesses} SET finished = true WHERE id = $1`, [logged.id]);
      return { ...result, processId: `process-${logged.id}` };
    },
    async stopAllSessions() {},
    async stopSession() {},
    async syncSkills(sessionId, request) {
      let written = 0;
      for (const skill of request.packages) {
        for (const file of skill.files) {
          const target = real(sessionId, `${SKILL_ROOT}/${skill.name}/${file.path}`);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.contentBase64, "base64"));
          written += 1;
        }
      }
      for (const name of request.removed) await rm(real(sessionId, `${SKILL_ROOT}/${name}`), { force: true, recursive: true });
      return { checked: written, removed: request.removed.length, written };
    },
    async writeFile(sessionId, path, content) {
      const target = real(sessionId, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
  };
}
