/**
 * The agent session's sandbox: real Bash in an isolated runner container with scoped workspaces.
 *
 * Export:
 * - `createSessionSandboxes`: opens the sandbox of a session for its turn. The mounts follow the
 *   verified authorization (personal/family trusted, group restricted); silent memory review gets
 *   none. The first open is stored, and every later open must mount the same folders.
 */
import type { Pool } from "pg";

import { isMemoryReviewSession } from "./lib/memory-review/memory-review-session.js";
import { openRunnerSandbox } from "./lib/sandbox-runner/runner-sandbox-backend.js";
import { sandboxSessionId } from "./lib/sessions/session-context.js";
import { requireWorkspaceAuthorization } from "./lib/workspaces/workspace-context.js";
import { workspaceRepository } from "./lib/workspaces/workspace-repository.js";
import type { SessionAuth } from "./runtime/context.js";
import type { RuntimeSandboxSession } from "./runtime/sandbox/types.js";
import { loadSandboxState, saveFirstSandboxState } from "./runtime/session/sandbox-state.js";

export function createSessionSandboxes(dependencies: { readonly baseUrl?: string; readonly database: Pick<Pool, "query"> }) {
  return async (session: { readonly auth: SessionAuth; readonly id: string }): Promise<RuntimeSandboxSession> => {
    const ctx = { session };
    // Silent review has no file tools or skills: it keeps a sandbox identity without compute.
    const mounts = isMemoryReviewSession(ctx) ? [] : await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
    const use = { mounts: [...mounts], sandboxSessionId: sandboxSessionId(ctx) };
    let stored = await loadSandboxState(dependencies.database, session.id);
    const sandbox = openRunnerSandbox({ baseUrl: dependencies.baseUrl, sessionId: session.id, stored, use });
    if (stored === null && !await saveFirstSandboxState(dependencies.database, session.id, sandbox.captureState())) {
      // Another open of the same session stored first; this one must agree with it.
      stored = await loadSandboxState(dependencies.database, session.id);
      return openRunnerSandbox({ baseUrl: dependencies.baseUrl, sessionId: session.id, stored, use }).session;
    }
    return sandbox.session;
  };
}
