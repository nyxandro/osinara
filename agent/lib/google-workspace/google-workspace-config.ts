/**
 * Google Workspace integration constants and lazy environment validation.
 *
 * Exports:
 * - OAuth endpoints, UserInfo endpoint, scope matrix, command limits, and state lifetime.
 * - `requireGoogleOAuthEnvironment`: validates integration secrets only when invoked.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireGoogleTokenEncryptionKey } from "./google-token-crypto.js";

export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_CALLBACK_PATH = "/eve/v1/google-oauth/callback";
export const GOOGLE_OAUTH_STATE_TTL_MILLISECONDS = 10 * 60_000;
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
export const GOOGLE_WORKSPACE_ACCESS_TOKEN_REFRESH_SKEW_MILLISECONDS = 60_000;
export const GOOGLE_WORKSPACE_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
export const GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MILLISECONDS = 30_000;
export const GOOGLE_WORKSPACE_PAGE_LIMIT_MAX = 10;

// Broad user scopes cover every supported read/write mode without app-only or admin impersonation.
export const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.delete",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships",
  "https://www.googleapis.com/auth/chat.users.readstate",
  "https://www.googleapis.com/auth/chat.users.spacesettings",
  "https://www.googleapis.com/auth/chat.users.availability",
  "https://www.googleapis.com/auth/chat.users.sections",
  "https://www.googleapis.com/auth/chat.customemojis",
] as const;

const environmentSchema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  INTEGRATION_TOKEN_ENCRYPTION_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.url(),
});

export interface GoogleOAuthEnvironment {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  redirectUri: string;
}

export function requireGoogleOAuthEnvironment(): GoogleOAuthEnvironment {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    console.error(JSON.stringify({ code: "AGENT_GOOGLE_CONFIG_MISSING", fields }));
    throw new AppError(
      "AGENT_GOOGLE_CONFIG_MISSING",
      "Подключение Google Workspace ещё не настроено владельцем",
    );
  }

  // Public callbacks require HTTPS, with a narrow localhost exception for integration tests.
  const publicBaseUrl = new URL(parsed.data.PUBLIC_BASE_URL);
  const localHttp = publicBaseUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(publicBaseUrl.hostname);
  if (publicBaseUrl.protocol !== "https:" && !localHttp) {
    throw new AppError(
      "AGENT_GOOGLE_PUBLIC_URL_INVALID",
      "Публичный адрес подключения Google должен использовать HTTPS",
    );
  }
  if (publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new AppError(
      "AGENT_GOOGLE_PUBLIC_URL_INVALID",
      "Публичный адрес подключения Google настроен некорректно",
    );
  }
  requireGoogleTokenEncryptionKey(parsed.data.INTEGRATION_TOKEN_ENCRYPTION_KEY);
  return {
    clientId: parsed.data.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_OAUTH_CLIENT_SECRET,
    encryptionKey: parsed.data.INTEGRATION_TOKEN_ENCRYPTION_KEY,
    redirectUri: new URL(GOOGLE_OAUTH_CALLBACK_PATH, publicBaseUrl).toString(),
  };
}
