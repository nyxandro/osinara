/**
 * Whether the sandbox has a working ripgrep; `glob` and `grep` fall back to find/grep without it.
 *
 * Export:
 * - `ripgrepIsAvailable`: probes once per sandbox session and caches the answer.
 *
 * A probe that cannot run at all fails the tool call instead of silently choosing the fallback; it
 * is not cached, so the next call asks again.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { SandboxSession } from "../sandbox/types.js";

const probes = new Map<string, Promise<boolean>>();

const RIPGREP_PROBE_COMMAND =
  "command -v rg >/dev/null 2>&1 || exit 127; " +
  "rg --line-number --color=never --hidden --glob '!.git/*' --max-count 1 -- " +
  "'__ripgrep_probe_never_matches__' /workspace";

async function runProbe(session: Pick<SandboxSession, "run">): Promise<boolean> {
  const result = await session.run({ command: RIPGREP_PROBE_COMMAND });
  return (result.exitCode === 0 || result.exitCode === 1) && result.stderr.trim().length === 0;
}

export async function ripgrepIsAvailable(session: Pick<SandboxSession, "id" | "run">): Promise<boolean> {
  let pending = probes.get(session.id);
  if (pending === undefined) {
    pending = runProbe(session);
    pending.catch(() => probes.delete(session.id));
    probes.set(session.id, pending);
  }
  return await pending;
}
