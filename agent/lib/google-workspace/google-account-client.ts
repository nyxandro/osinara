/**
 * Google OpenID UserInfo identity boundary.
 *
 * Export:
 * - `getGoogleAccountIdentity`: resolves a stable subject and verified email after OAuth.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  GOOGLE_USERINFO_URL,
} from "./google-workspace-config.js";

export interface GoogleAccountIdentity {
  email: string;
  subject: string;
}

const identitySchema = z.object({
  email: z.email().max(320),
  email_verified: z.literal(true),
  sub: z.string().min(1).max(255),
});

export async function getGoogleAccountIdentity(accessToken: string): Promise<GoogleAccountIdentity> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      method: "GET",
      signal: AbortSignal.timeout(GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_IDENTITY_NETWORK_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_IDENTITY_NETWORK_FAILED: Не удалось получить профиль Google";
    }
    throw error;
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_IDENTITY_REQUEST_FAILED",
      providerStatus: response.status,
    }));
    throw new AppError(
      "AGENT_GOOGLE_IDENTITY_REQUEST_FAILED",
      "Google не подтвердил данные аккаунта. Подключите аккаунт заново",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_IDENTITY_RESPONSE_INVALID",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_IDENTITY_RESPONSE_INVALID: Google вернул некорректный профиль";
    }
    throw error;
  }
  const parsed = identitySchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GOOGLE_IDENTITY_RESPONSE_INVALID",
      "Google не вернул подтверждённый адрес аккаунта. Подключите другой аккаунт",
    );
  }
  return { email: parsed.data.email, subject: parsed.data.sub };
}
