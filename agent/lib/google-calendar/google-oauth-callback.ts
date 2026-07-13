/**
 * Fixed Google OAuth callback boundary.
 *
 * Exports:
 * - `createGoogleOAuthCallbackHandler`: injectable one-time grant completion handler.
 * - `handleGoogleOAuthCallback`: production callback used by the custom Eve channel.
 */
import type { GoogleCalendarIdentity } from "./google-calendar-api-client.js";
import { getGooglePrimaryCalendar } from "./google-calendar-api-client.js";
import { requireGoogleOAuthEnvironment } from "./google-calendar-config.js";
import {
  type ClaimedGoogleAuthorization,
  googleIntegrationRepository,
} from "./google-integration-repository.js";
import {
  type GoogleAuthorizationTokenResult,
  type GoogleOAuthClientConfig,
  exchangeGoogleAuthorizationCode,
} from "./google-oauth-client.js";

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
  ): Promise<unknown>;
  exchangeCode(
    config: GoogleOAuthClientConfig,
    code: string,
  ): Promise<GoogleAuthorizationTokenResult>;
  failAuthorization(claim: ClaimedGoogleAuthorization, errorCode: string): Promise<void>;
  getConfig(): CallbackConfig;
  getPrimaryCalendar(accessToken: string): Promise<GoogleCalendarIdentity>;
  now(): Date;
}

function htmlResponse(status: number, title: string, message: string): Response {
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

export function createGoogleOAuthCallbackHandler(dependencies: GoogleOAuthCallbackDependencies) {
  return async function handleCallback(request: Request): Promise<Response> {
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
        "AGENT_GOOGLE_OAUTH_DENIED: Google Calendar не был подключён.",
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

    // Any failure after claim terminates this state and rethrows the original provider error.
    const completion = dependencies.exchangeCode(config, code).then(async (tokens) => {
      const primary = await dependencies.getPrimaryCalendar(tokens.accessToken);
      await dependencies.completeAuthorization(claim, {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: new Date(
          dependencies.now().getTime() + tokens.expiresInSeconds * 1_000,
        ),
        displayName: primary.summary,
        encryptionKey: config.encryptionKey,
        externalAccountId: primary.id,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scopes,
      });
      return htmlResponse(
        200,
        "Google Calendar подключён",
        "Аккаунт безопасно связан с вашим пользователем Osinara.",
      );
    });
    return completion.then(undefined, async (error: unknown) => {
      await dependencies.failAuthorization(claim, "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED");
      console.error(JSON.stringify({
        code: "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      throw error;
    });
  };
}

export const handleGoogleOAuthCallback = createGoogleOAuthCallbackHandler({
  claimAuthorization: googleIntegrationRepository.claimAuthorization,
  completeAuthorization: googleIntegrationRepository.completeAuthorization,
  exchangeCode: exchangeGoogleAuthorizationCode,
  failAuthorization: googleIntegrationRepository.failAuthorization,
  getConfig: requireGoogleOAuthEnvironment,
  getPrimaryCalendar: getGooglePrimaryCalendar,
  now: () => new Date(),
});
