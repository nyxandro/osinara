/**
 * Production agent sandbox configuration.
 *
 * Constructs:
 * - Real Linux Bash in isolated runner containers with scoped persistent workspaces.
 * - Persistent personal/family tools and fail-closed external-group restrictions.
 */
import { defineSandbox } from "eve/sandbox";

import { scopedWorkspaceRunner } from "./lib/sandbox-runner/runner-sandbox-backend.js";
import { requireWorkspaceAuthorization } from "./lib/workspaces/workspace-context.js";
import { workspaceRepository } from "./lib/workspaces/workspace-repository.js";

export default defineSandbox({
  backend: scopedWorkspaceRunner(),
  async onSession({ ctx, use }) {
    const mounts = await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
    await use({ mounts });
  },
});
