/**
 * Workspace-bound Google OAuth profile management tool.
 *
 * Export:
 * - `googleWorkspaceConnectionStatus`: maps grants and native profile presence to readiness.
 * - `createGoogleWorkspaceConnectionManager`: injectable explicit management boundaries.
 * - `manage_google_workspace_connection`: connects, inspects, or disconnects native gws credentials.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleAccountRepository } from "../google-workspace/google-account-repository.js";
import { groupApprovalDenial } from "../telegram-hitl/approval-surface.js";
import type { GoogleIntegrationScope } from "../google-workspace/google-integration-contract.js";
import { resolveGoogleWorkspaceAuthorization } from "../google-workspace/google-workspace-context.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "../google-workspace/google-workspace-config.js";
import { googleIntegrationRepository } from "../google-workspace/google-integration-repository.js";
import { startGoogleWorkspaceAuthorization } from "../google-workspace/google-oauth-service.js";
import { googleWorkspaceProfileStore } from "../google-workspace/google-workspace-profile-store.js";

const connectionSchema = z.object({
  action: z.enum(["connect", "disconnect", "status"]),
}).strict();

interface GoogleWorkspaceConnectionStatusAccount {
  displayName: string;
  scopes: readonly string[];
}

interface GoogleWorkspaceConnectionStatusResult {
  account?: string;
  connected: boolean;
  materializationRequired?: true;
  missingScopes?: string[];
  ready: boolean;
  reconnectRequired?: true;
  scope: GoogleIntegrationScope;
}

export function googleWorkspaceConnectionStatus(
  account: GoogleWorkspaceConnectionStatusAccount | null,
  scope: GoogleIntegrationScope,
  profileExists: boolean,
): GoogleWorkspaceConnectionStatusResult {
  if (!account) return { connected: false, ready: false, scope };

  // Stored grants predate scope expansions; require consent instead of exposing stale gws profiles.
  const missingScopes = missingGoogleWorkspaceScopes(account.scopes);
  if (missingScopes.length) {
    return {
      account: account.displayName,
      connected: false,
      missingScopes,
      ready: false,
      reconnectRequired: true,
      scope,
    };
  }

  if (!profileExists) {
    return {
      account: account.displayName,
      connected: false,
      materializationRequired: true,
      ready: false,
      scope,
    };
  }

  return {
    account: account.displayName,
    connected: true,
    ready: true,
    scope,
  };
}

interface GoogleWorkspaceConnectionManagerDependencies {
  disconnect: typeof googleIntegrationRepository.disconnect;
  getConfig: typeof requireGoogleOAuthEnvironment;
  profileExists: typeof googleWorkspaceProfileStore.exists;
  removeProfile: typeof googleWorkspaceProfileStore.remove;
  startAuthorization: typeof startGoogleWorkspaceAuthorization;
  withProfileAccount: typeof googleAccountRepository.withProfileAccount;
  writeProfile: typeof googleWorkspaceProfileStore.write;
}

export function createGoogleWorkspaceConnectionManager(
  dependencies: GoogleWorkspaceConnectionManagerDependencies,
) {
  return async function manageConnection(
    input: z.infer<typeof connectionSchema>,
    auth: Awaited<ReturnType<typeof resolveGoogleWorkspaceAuthorization>>,
  ) {
    if (input.action === "disconnect") {
      return {
        disconnected: await dependencies.disconnect(
          auth,
          async () => await dependencies.removeProfile(auth.workspaceId),
        ),
        ready: false,
        scope: auth.scope,
      };
    }

    // Status and connect need the exact provider secrets to decrypt or materialize credentials.
    const config = dependencies.getConfig();
    const result = await dependencies.withProfileAccount(
      auth,
      config.encryptionKey,
      input.action === "connect",
      async (account) => {
        const profileExists = await dependencies.profileExists(auth.workspaceId);
        const status = googleWorkspaceConnectionStatus(account, auth.scope, profileExists);
        if (input.action === "status") return status;

        // Connect is an explicit management boundary for both migrations and OAuth replacement.
        if (account && !status.reconnectRequired) {
          if (!profileExists) {
            await dependencies.writeProfile(auth.workspaceId, {
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: account.refreshToken,
              type: "authorized_user",
            });
          }
          return {
            account: account.displayName,
            connected: true,
            ready: true,
            scope: auth.scope,
          };
        }

        // A stale or orphaned profile must not remain executable while new consent is pending.
        if (profileExists) await dependencies.removeProfile(auth.workspaceId);
        return null;
      },
    );
    if (result) return result;

    // Repository-level transaction locking deduplicates pending states without nested DB locks.
    return {
      ...await dependencies.startAuthorization(auth),
      ready: false,
    };
  };
}

const manageGoogleWorkspaceConnection = createGoogleWorkspaceConnectionManager({
  disconnect: googleIntegrationRepository.disconnect,
  getConfig: requireGoogleOAuthEnvironment,
  profileExists: googleWorkspaceProfileStore.exists,
  removeProfile: googleWorkspaceProfileStore.remove,
  startAuthorization: startGoogleWorkspaceAuthorization,
  withProfileAccount: googleAccountRepository.withProfileAccount,
  writeProfile: googleWorkspaceProfileStore.write,
});

export default defineTool({
  approval: ({ session, toolInput }) =>
    toolInput?.action === "disconnect"
      ? groupApprovalDenial({ session }) ?? "user-approval"
      : "not-applicable",
  description:
    "Управлять OAuth-профилем Google Workspace текущей personal/family области. Используй {\"action\":\"status\"} для connected/ready/missingScopes, {\"action\":\"connect\"} для защищённой OAuth-ссылки и {\"action\":\"disconnect\"} только по явной просьбе с Eve HITL. connect не означает ready до завершения OAuth. Команды Google выполняются только через execute_google_workspace; COMMAND_FORBIDDEN не означает read-only OAuth.",
  inputSchema: connectionSchema,
  async execute(input, ctx) {
    const auth = await resolveGoogleWorkspaceAuthorization(ctx);
    return await manageGoogleWorkspaceConnection(input, auth);
  },
});
