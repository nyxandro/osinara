/**
 * Google Workspace OAuth 2.0 web-server HTTP client.
 *
 * Exports:
 * - `GOOGLE_WORKSPACE_SCOPES`: exact user identity and Workspace grant matrix.
 * - Consent URL, authorization-code exchange, and refresh-token exchange helpers.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  GOOGLE_WORKSPACE_SCOPES,
} from "./google-workspace-config.js";

export { GOOGLE_WORKSPACE_SCOPES } from "./google-workspace-config.js";

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export interface GoogleAuthorizationTokenResult extends GoogleAccessTokenResult {
  refreshToken: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().min(1),
  token_type: z.literal("Bearer"),
});

const providerErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

export function buildGoogleAuthorizationUrl(
  config: GoogleOAuthClientConfig,
  state: string,
): string {
  if (!state) throw new AppError("AGENT_GOOGLE_OAUTH_STATE_INVALID", "OAuth state не создан");
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    access_type: "offline",
    client_id: config.clientId,
    include_granted_scopes: "true",
    prompt: "consent select_account",
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
    state,
  }).toString();
  return url.toString();
}

async function requestToken(body: URLSearchParams): Promise<z.infer<typeof tokenResponseSchema>> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_OAUTH_NETWORK_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_OAUTH_NETWORK_FAILED: Не удалось связаться с Google OAuth";
    }
    throw error;
  }

  const rawBody = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_OAUTH_RESPONSE_INVALID",
      providerStatus: response.status,
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_OAUTH_RESPONSE_INVALID: Google OAuth вернул некорректный ответ";
    }
    throw error;
  }
  if (!response.ok) {
    const providerError = providerErrorSchema.safeParse(payload);
    const providerCode = providerError.success ? providerError.data.error : "unknown_provider_error";
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_OAUTH_PROVIDER_FAILED",
      providerCode,
      providerStatus: response.status,
    }));
    if (providerCode === "invalid_grant") {
      throw new AppError(
        "AGENT_GOOGLE_AUTH_EXPIRED",
        "Доступ к Google Workspace истёк или был отозван. Подключите аккаунт заново",
      );
    }
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_PROVIDER_FAILED",
      "Google не завершил авторизацию. Попробуйте подключить аккаунт ещё раз",
    );
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_RESPONSE_INVALID",
      "Google OAuth вернул неполный ответ. Подключите аккаунт ещё раз",
    );
  }
  const grantedScopes = parsed.data.scope.split(" ").filter(Boolean);
  const missingScope = GOOGLE_WORKSPACE_SCOPES.find((scope) => !grantedScopes.includes(scope));
  if (missingScope) {
    throw new AppError(
      "AGENT_GOOGLE_SCOPE_MISSING",
      "Google не предоставил все разрешения Workspace. Подключите аккаунт и подтвердите доступ",
    );
  }
  return parsed.data;
}

export async function exchangeGoogleAuthorizationCode(
  config: GoogleOAuthClientConfig,
  code: string,
): Promise<GoogleAuthorizationTokenResult> {
  if (!code) {
    throw new AppError("AGENT_GOOGLE_AUTH_CODE_MISSING", "Google не вернул код авторизации");
  }
  const token = await requestToken(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  }));
  if (!token.refresh_token) {
    throw new AppError(
      "AGENT_GOOGLE_REFRESH_TOKEN_MISSING",
      "Google не выдал долговременный доступ. Отзовите старый доступ и подключите аккаунт снова",
    );
  }
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in,
    refreshToken: token.refresh_token,
    scopes: token.scope.split(" ").filter(Boolean),
  };
}

export async function refreshGoogleAccessToken(
  config: GoogleOAuthClientConfig,
  refreshToken: string,
): Promise<GoogleAccessTokenResult> {
  const token = await requestToken(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }));
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in,
    scopes: token.scope.split(" ").filter(Boolean),
  };
}
