/**
 * Fixed Google Workspace OAuth callback boundary.
 *
 * Exports:
 * - `createGoogleOAuthCallbackHandler`: injectable one-time grant completion handler.
 * - `handleGoogleOAuthCallback`: production callback behind the fixed callback route.
 *
 * The callback is the HTTP boundary a person reaches from the browser: every failure ends in a page
 * that names the reason in Russian with its code, never in an empty server error.
 */
import type { GoogleAccountIdentity } from "./google-account-client.js";
import { getGoogleAccountIdentity } from "./google-account-client.js";
import { AppError, isAppError } from "../app-error.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import type { ClaimedGoogleAuthorization } from "./google-integration-contract.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";
import {
  type GoogleAuthorizationTokenResult,
  type GoogleOAuthClientConfig,
  exchangeGoogleAuthorizationCode,
} from "./google-oauth-client.js";
import {
  googleWorkspaceProfileStore,
  type GoogleWorkspaceAuthorizedUserCredentials,
} from "./google-workspace-profile-store.js";

interface CallbackConfig extends GoogleOAuthClientConfig {
  encryptionKey: string;
}

interface GoogleOAuthCallbackDependencies {
  claimAuthorization(rawState: string, now: Date): Promise<ClaimedGoogleAuthorization>;
  completeAuthorization(
    claim: ClaimedGoogleAuthorization,
    input: {
      accessToken: string;
      accessTokenExpiresAt: Date;
      displayName: string;
      encryptionKey: string;
      externalAccountId: string;
      refreshToken: string;
      scopes: string[];
    },
    materializeProfile: () => Promise<void>,
  ): Promise<unknown>;
  exchangeCode(
    config: GoogleOAuthClientConfig,
    code: string,
  ): Promise<GoogleAuthorizationTokenResult>;
  failAuthorization(claim: ClaimedGoogleAuthorization, errorCode: string): Promise<void>;
  getAccountIdentity(accessToken: string): Promise<GoogleAccountIdentity>;
  getConfig(): CallbackConfig;
  now(): Date;
  writeProfile(
    workspaceId: string,
    credentials: GoogleWorkspaceAuthorizedUserCredentials,
  ): Promise<void>;
}

const CALLBACK_FAILED_CODE = "AGENT_GOOGLE_OAUTH_CALLBACK_FAILED";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function htmlResponse(status: number, title: string, text: string): Response {
  const message = escapeHtml(text);
  const body = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p><p>Можно закрыть эту страницу и вернуться в Telegram.</p></main></body></html>`;
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

// An AppError carries a safe Russian explanation written for the person; anything else stays in the log.
function failurePage(error: unknown): Response {
  if (isAppError(error)) return htmlResponse(400, "Авторизация не завершена", `${error.message}.`);
  return htmlResponse(
    500,
    "Авторизация не завершена",
    `${CALLBACK_FAILED_CODE}: не удалось подключить Google Workspace. ` +
      "Запросите новую ссылку в Telegram и попробуйте ещё раз.",
  );
}

async function completeCallback(
  dependencies: GoogleOAuthCallbackDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawState = params.get("state");
  if (!rawState) {
    return htmlResponse(
      400,
      "Авторизация не завершена",
      "AGENT_GOOGLE_OAUTH_STATE_INVALID: запросите новую ссылку в Telegram.",
    );
  }
  const claim = await dependencies.claimAuthorization(rawState, dependencies.now());
  if (params.get("error")) {
    await dependencies.failAuthorization(claim, "AGENT_GOOGLE_OAUTH_DENIED");
    return htmlResponse(
      400,
      "Доступ не предоставлен",
      "AGENT_GOOGLE_OAUTH_DENIED: Google Workspace не был подключён.",
    );
  }
  const code = params.get("code");
  if (!code) {
    await dependencies.failAuthorization(claim, "AGENT_GOOGLE_AUTH_CODE_MISSING");
    return htmlResponse(
      400,
      "Авторизация не завершена",
      "AGENT_GOOGLE_AUTH_CODE_MISSING: Google не вернул код авторизации.",
    );
  }
  const config = dependencies.getConfig();

  // Repository completion rechecks live management and holds one workspace transaction across
  // credential persistence plus derived profile materialization.
  const completion = (async () => {
    const tokens = await dependencies.exchangeCode(config, code);
    const missingScopes = missingGoogleWorkspaceScopes(tokens.scopes);
    if (missingScopes.length) {
      throw new AppError(
        "AGENT_GOOGLE_SCOPE_INCOMPLETE",
        "Google предоставил не все разрешения Workspace. Запросите новую ссылку и подтвердите весь доступ",
      );
    }
    const identity = await dependencies.getAccountIdentity(tokens.accessToken);
    await dependencies.completeAuthorization(claim, {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(
        dependencies.now().getTime() + tokens.expiresInSeconds * 1_000,
      ),
      displayName: identity.email,
      encryptionKey: config.encryptionKey,
      externalAccountId: identity.subject,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    }, async () => {
      // Native gws receives only a complete profile belonging to the target workspace volume.
      await dependencies.writeProfile(claim.workspaceId, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: tokens.refreshToken,
        type: "authorized_user",
      });
    });
    return htmlResponse(
      200,
      "Google Workspace подключён",
      "Аккаунт безопасно связан с выбранной областью Osinara.",
    );
  })();
  return completion.then(undefined, async (error: unknown) => {
    await dependencies.failAuthorization(claim, "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED");
    throw error;
  });
}

export function createGoogleOAuthCallbackHandler(dependencies: GoogleOAuthCallbackDependencies) {
  return async function handleCallback(request: Request): Promise<Response> {
    try {
      return await completeCallback(dependencies, request);
    } catch (error) {
      console.error(JSON.stringify({
        code: CALLBACK_FAILED_CODE,
        error: error instanceof Error ? error.message : String(error),
        errorCode: isAppError(error) ? error.code : null,
      }));
      return failurePage(error);
    }
  };
}

export const handleGoogleOAuthCallback = createGoogleOAuthCallbackHandler({
  claimAuthorization: googleIntegrationRepository.claimAuthorization,
  completeAuthorization: googleIntegrationRepository.completeAuthorization,
  exchangeCode: exchangeGoogleAuthorizationCode,
  failAuthorization: googleIntegrationRepository.failAuthorization,
  getAccountIdentity: getGoogleAccountIdentity,
  getConfig: requireGoogleOAuthEnvironment,
  now: () => new Date(),
  writeProfile: googleWorkspaceProfileStore.write,
});
