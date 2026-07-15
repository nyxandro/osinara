/**
 * Workspace-bound Google OAuth profile management tool.
 *
 * Export:
 * - `manage_google_workspace_connection`: connects, inspects, or disconnects native gws credentials.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolveGoogleWorkspaceAuthorization } from "../lib/google-workspace/google-workspace-context.js";
import { requireGoogleOAuthEnvironment } from "../lib/google-workspace/google-workspace-config.js";
import { googleIntegrationRepository } from "../lib/google-workspace/google-integration-repository.js";
import { startGoogleWorkspaceAuthorization } from "../lib/google-workspace/google-oauth-service.js";
import { googleWorkspaceProfileStore } from "../lib/google-workspace/google-workspace-profile-store.js";

const connectionSchema = z.object({
  action: z.enum(["connect", "disconnect", "status"]),
}).strict();

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "disconnect" ? "user-approval" : "not-applicable",
  description:
    "Подключить, проверить или отключить OAuth-профиль для native gws текущей личной или семейной области. Команды Google выполняются через gws в Bash, не через этот инструмент.",
  inputSchema: connectionSchema,
  async execute(input, ctx) {
    const auth = await resolveGoogleWorkspaceAuthorization(ctx);
    if (input.action === "connect") {
      return await startGoogleWorkspaceAuthorization(auth);
    }

    if (input.action === "disconnect") {
      return await googleIntegrationRepository.withProfileLock(auth.workspaceId, async () => {
        // Authorize before touching the shared file, then remove access before metadata.
        await googleIntegrationRepository.assertManagement(auth);
        await googleWorkspaceProfileStore.remove(auth.workspaceId);
        return {
          disconnected: await googleIntegrationRepository.disconnect(auth),
          scope: auth.scope,
        };
      });
    }

    return await googleIntegrationRepository.withProfileLock(auth.workspaceId, async () => {
      const config = requireGoogleOAuthEnvironment();
      const account = await googleIntegrationRepository.getDefaultAccount(auth, config.encryptionKey);
      if (!account) return { connected: false, scope: auth.scope };

      // This also performs the approved one-time migration of an existing personal grant.
      await googleWorkspaceProfileStore.write(auth.workspaceId, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: account.refreshToken,
        type: "authorized_user",
      });
      return {
        account: account.displayName,
        connected: true,
        scope: auth.scope,
      };
    });
  },
});
