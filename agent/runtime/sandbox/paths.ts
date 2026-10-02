/**
 * Paths the model writes for the sandbox: a leading `$HOME`, and where skill packages live.
 *
 * Exports:
 * - `resolveSandboxModelPath`: expands a leading `$HOME` without evaluating any other shell syntax.
 * - `resolveAbsoluteFilePath`: the same, and rejects a relative result with Eve's wording.
 * - `resolveSandboxSkillRoot`: `$HOME/.agents/skills`, or `/workspace/skills` when the sandbox has
 *   no usable home directory (the root the skill list in the prompt points at).
 *
 * Derived from eve 0.40.0 `shared/skill-paths.ts` and `execution/sandbox/require-sandbox.ts`
 * (Apache-2.0, see NOTICE-eve). Changes: a failing home probe (the command cannot run) is an
 * error instead of a silent fallback; only a sandbox that answers without a usable home gets the
 * documented `/workspace/skills` root. The probe result is cached per sandbox session.
 */
import type { SandboxSession } from "./types.js";

const MODEL_HOME_ROOT = "$HOME";
const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;
const FALLBACK_SKILL_ROOT = "/workspace/skills";
const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

type ProbedSandbox = Pick<SandboxSession, "run">;
const sandboxHomeCache = new WeakMap<ProbedSandbox, Promise<string | null>>();

function isModelHomePath(path: string): boolean {
  return path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`);
}

function isModelSkillPath(path: string): boolean {
  return path === MODEL_SKILL_ROOT || path.startsWith(`${MODEL_SKILL_ROOT}/`);
}

function isUsableSandboxHome(path: string): boolean {
  return path.length > 0 && path.startsWith("/") && !path.includes("\0") && !path.includes("\n") && !path.includes("\r");
}

async function probeSandboxHome(sandbox: ProbedSandbox): Promise<string | null> {
  const result = await sandbox.run({ command: HOME_PROBE_COMMAND });
  if (result.exitCode !== 0) return null;
  const home = result.stdout.trim();
  if (!isUsableSandboxHome(home)) return null;
  return home === "/" ? home : home.replace(/\/+$/u, "");
}

function resolveSandboxHome(sandbox: ProbedSandbox): Promise<string | null> {
  let cached = sandboxHomeCache.get(sandbox);
  if (cached === undefined) {
    cached = probeSandboxHome(sandbox);
    // A failed probe must not stay cached: the next call asks the sandbox again.
    cached.catch(() => sandboxHomeCache.delete(sandbox));
    sandboxHomeCache.set(sandbox, cached);
  }
  return cached;
}

export async function resolveSandboxModelPath(input: { readonly path: string; readonly sandbox: ProbedSandbox }): Promise<string> {
  if (!isModelHomePath(input.path)) return input.path;
  const home = await resolveSandboxHome(input.sandbox);
  if (home !== null) {
    const suffix = input.path.slice(MODEL_HOME_ROOT.length);
    return suffix.length === 0 ? home : `${home === "/" ? "" : home}${suffix}`;
  }
  if (isModelSkillPath(input.path)) return `${FALLBACK_SKILL_ROOT}${input.path.slice(MODEL_SKILL_ROOT.length)}`;
  return input.path;
}

export async function resolveAbsoluteFilePath(sandbox: ProbedSandbox, filePath: string): Promise<string> {
  const resolvedPath = await resolveSandboxModelPath({ path: filePath, sandbox });
  if (!resolvedPath.startsWith("/")) {
    throw new Error(
      `filePath must be an absolute path. Received: "${filePath}". ` +
        "Use an absolute path such as /workspace/foo.ts or a path beginning with $HOME/.",
    );
  }
  return resolvedPath;
}

export async function resolveSandboxSkillRoot(sandbox: ProbedSandbox): Promise<string> {
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox });
}
