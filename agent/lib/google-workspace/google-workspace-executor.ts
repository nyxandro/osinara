/**
 * Credentialed Google Workspace execution service shared by model-facing tools.
 *
 * Exports:
 * - `createGoogleWorkspaceExecutor`: injectable live authorization and process boundary.
 * - `executeGoogleWorkspace`: production exact-argv executor.
 * - `withAuthorizedGoogleWorkspaceExecution`: one live profile operation for trusted metadata reads.
 */
import type { ToolContext } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import { withGoogleWorkspaceExecutionAccount } from "./google-execution-authorization.js";
import { classifyGoogleWorkspaceCommand } from "./google-workspace-command-policy.js";
import { runGoogleWorkspaceCommand } from "./google-workspace-command-runner.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { resolveGoogleWorkspaceAuthorization } from "./google-workspace-context.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import { refreshGoogleAccessToken } from "./google-oauth-client.js";
import { googleWorkspaceProfileStore } from "./google-workspace-profile-store.js";

const MODEL_FACING_OUTPUT_MAX_BYTES = 256 * 1024;

export interface GoogleWorkspaceExecutionProfile {
  displayName: string;
  profileRef: string;
}

function modelFacingOutput(
  kind: "mutation" | "read",
  result: { stderr: string; stdout: string },
) {
  const byteLength = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (byteLength <= MODEL_FACING_OUTPUT_MAX_BYTES) {
    return { completed: true, stderr: result.stderr, stdout: result.stdout };
  }
  if (kind === "mutation") {
    // The side effect has completed; returning a bounded success cannot invite a duplicate retry.
    return {
      completed: true,
      outputBytes: byteLength,
      outputTruncated: true,
      stderr: "",
      stdout: "",
    };
  }
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_OUTPUT_TOO_LARGE",
    "Результат Google Workspace слишком велик. Уточните фильтр, период или размер страницы",
  );
}

interface GoogleWorkspaceExecutorDependencies {
  resolveAuthorization(ctx: ToolContext): Promise<GoogleIntegrationAuthorization>;
  run(
    argv: readonly string[],
    kind: "mutation" | "read",
    auth: GoogleIntegrationAuthorization,
    accessToken: string,
    ctx: ToolContext,
  ): ReturnType<typeof runGoogleWorkspaceCommand>;
  withAuthorizedExecution<T>(
    auth: GoogleIntegrationAuthorization,
    operation: (
      accessToken: string,
      profile: GoogleWorkspaceExecutionProfile,
    ) => Promise<T>,
  ): Promise<T>;
}

export async function withAuthorizedGoogleWorkspaceExecution<T>(
  auth: GoogleIntegrationAuthorization,
  operation: (
    accessToken: string,
    profile: GoogleWorkspaceExecutionProfile,
  ) => Promise<T>,
): Promise<T> {
  const config = requireGoogleOAuthEnvironment();
  return await withGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
    const profileExists = await googleWorkspaceProfileStore.exists(auth.workspaceId);
    if (!account || missingGoogleWorkspaceScopes(account.scopes).length > 0 || !profileExists) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY",
        "Профиль Google Workspace не готов. Подключите аккаунт заново",
      );
    }

    const accessToken = (await refreshGoogleAccessToken(config, account.refreshToken)).accessToken;
    if (!await googleWorkspaceProfileStore.exists(auth.workspaceId)) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
        "Профиль Google Workspace изменился во время подтверждения. Повторите запрос",
      );
    }
    return await operation(accessToken, {
      displayName: account.displayName,
      profileRef: account.id,
    });
  });
}

export function createGoogleWorkspaceExecutor(dependencies: GoogleWorkspaceExecutorDependencies) {
  return async function executeGoogleWorkspaceArgv(
    input: { argv: string[]; expectedProfileRef?: string },
    ctx: ToolContext,
  ) {
    // Classification is repeated inside execute so direct/replayed calls cannot bypass policy.
    const kind = classifyGoogleWorkspaceCommand(input.argv);
    const auth = await dependencies.resolveAuthorization(ctx);

    // This DB/profile check intentionally occurs after a potentially long HITL pause.
    return await dependencies.withAuthorizedExecution(auth, async (accessToken, profile) => {
      if (
        input.expectedProfileRef !== undefined &&
        input.expectedProfileRef !== profile.profileRef
      ) {
        throw new AppError(
          "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
          "Подключённый Google-профиль изменился после выбора объекта. Повторите запрос",
        );
      }
      const result = await dependencies.run(input.argv, kind, auth, accessToken, ctx);
      return {
        kind,
        profileRef: profile.profileRef,
        scope: auth.scope,
        ...modelFacingOutput(kind, result),
      };
    });
  };
}

export const executeGoogleWorkspace = createGoogleWorkspaceExecutor({
  resolveAuthorization: resolveGoogleWorkspaceAuthorization,
  run: (argv, kind, auth, accessToken, ctx) =>
    runGoogleWorkspaceCommand(argv, kind, auth, accessToken, ctx),
  withAuthorizedExecution: withAuthorizedGoogleWorkspaceExecution,
});
