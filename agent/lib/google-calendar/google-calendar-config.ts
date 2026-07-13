/**
 * Google Calendar integration constants and lazy environment validation.
 *
 * Exports:
 * - OAuth/API endpoints, callback path, timeout, state TTL, and required scopes.
 * - `requireGoogleOAuthEnvironment`: validates secrets only when integration is invoked.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireGoogleTokenEncryptionKey } from "./google-token-crypto.js";

export const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_CALLBACK_PATH = "/eve/v1/google-oauth/callback";
export const GOOGLE_OAUTH_STATE_TTL_MILLISECONDS = 10 * 60_000;
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
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
      "Подключение Google Calendar ещё не настроено владельцем",
    );
  }
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
