/**
 * Typed Google Calendar REST API boundary.
 *
 * Export:
 * - `getGooglePrimaryCalendar`: resolves stable account/calendar metadata after OAuth.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  GOOGLE_CALENDAR_API_BASE_URL,
  GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
} from "./google-calendar-config.js";

export interface GoogleCalendarIdentity {
  accessRole: "freeBusyReader" | "owner" | "reader" | "writer";
  id: string;
  summary: string;
  timeZone: string;
}

const calendarIdentitySchema = z.object({
  accessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]),
  id: z.string().min(1).max(1_024),
  primary: z.literal(true),
  summary: z.string().min(1).max(500),
  timeZone: z.string().min(1).max(100),
});

export async function getGooglePrimaryCalendar(
  accessToken: string,
): Promise<GoogleCalendarIdentity> {
  let response: Response;
  try {
    response = await fetch(`${GOOGLE_CALENDAR_API_BASE_URL}/users/me/calendarList/primary`, {
      headers: { authorization: `Bearer ${accessToken}` },
      method: "GET",
      signal: AbortSignal.timeout(GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_CALENDAR_NETWORK_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      operation: "calendarList.get.primary",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_CALENDAR_NETWORK_FAILED: Не удалось связаться с Google Calendar";
    }
    throw error;
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_CALENDAR_REQUEST_FAILED",
      operation: "calendarList.get.primary",
      providerStatus: response.status,
    }));
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        "AGENT_GOOGLE_AUTH_EXPIRED",
        "Google отклонил доступ к календарю. Подключите аккаунт заново",
      );
    }
    throw new AppError(
      "AGENT_GOOGLE_CALENDAR_REQUEST_FAILED",
      "Google Calendar временно не выполнил запрос. Попробуйте позже",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_CALENDAR_RESPONSE_INVALID",
      operation: "calendarList.get.primary",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_CALENDAR_RESPONSE_INVALID: Google Calendar вернул некорректный ответ";
    }
    throw error;
  }
  const parsed = calendarIdentitySchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GOOGLE_CALENDAR_RESPONSE_INVALID",
      "Google Calendar не вернул сведения об основном календаре",
    );
  }
  const { accessRole, id, summary, timeZone } = parsed.data;
  return { accessRole, id, summary, timeZone };
}
