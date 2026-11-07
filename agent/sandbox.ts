/**
 * The agent session's sandbox: real Bash in an isolated runner container with scoped workspaces.
 *
 * Export:
 * - `createSessionSandboxes`: opens the sandbox of a session for its turn. The mounts follow the
 *   verified authorization (personal/family trusted, group restricted); silent memory review gets
 *   none. The first open is stored, and every later open must mount the same folders. Each command
 *   gets the API keys granted to those folders' workspaces. A guest's sandbox (#471) runs on a network of its
 *   own, so nothing the owner opened to the family's sandboxes reaches it.
 */
import type { Pool } from "pg";

import { apiKeySandboxEnvironment } from "./lib/api-keys/api-key-environment.js";
import { loadGuestAccessPolicy } from "./lib/guests/guest-repository.js";
import { isMemoryReviewSession } from "./lib/memory-review/memory-review-session.js";
import { openRunnerSandbox } from "./lib/sandbox-runner/runner-sandbox-backend.js";
import { isPrivateQuestionSession } from "./lib/private-questions/private-question-session.js";
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
    // A private question reads no files either (#467): nothing of a group's folder reaches one person's answer.
    const noCompute = isMemoryReviewSession(ctx) || isPrivateQuestionSession(ctx);
    const authorization = noCompute ? null : requireWorkspaceAuthorization(ctx);
    const mounts = authorization === null ? [] : await workspaceRepository.mounts(authorization);
    const use = { mounts: [...mounts], sandboxSessionId: sandboxSessionId(ctx) };
    // A personal folder means a person's own trusted sandbox; it is a guest's when their family is a guest's own.
    const ownNetwork = authorization !== null && mounts.some((mount) => mount.mountPoint === "personal") &&
      await loadGuestAccessPolicy(authorization.familyId) !== null;
    const environment = () => apiKeySandboxEnvironment(mounts.map((mount) => mount.workspaceId));
    let stored = await loadSandboxState(dependencies.database, session.id);
    const open = () => openRunnerSandbox({ baseUrl: dependencies.baseUrl, environment, ownNetwork, sessionId: session.id, stored, use });
    const sandbox = open();
    if (stored === null && !await saveFirstSandboxState(dependencies.database, session.id, sandbox.captureState())) {
      // Another open of the same session stored first; this one must agree with it.
      stored = await loadSandboxState(dependencies.database, session.id);
      return open().session;
    }
    return sandbox.session;
  };
}
