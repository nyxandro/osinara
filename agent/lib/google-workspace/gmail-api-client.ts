/**
 * Direct read-only Gmail REST boundary for trusted approval metadata.
 *
 * Export:
 * - `fetchGmailMessageMetadata`: From, Subject and Date headers plus the snippet of one exact message.
 *
 * An approval card for a batch needs metadata of up to 30 messages within seconds, while one
 * credentialed gws container takes 5+ seconds to start on the production host. The request has a
 * fixed backend-owned shape, like the UserInfo identity read; every mutation still runs through gws.
 * Failures carry their diagnostic as `cause`; the batch loader logs the first one, once.
 */
import { AppError } from "../app-error.js";
import {
  GMAIL_MESSAGES_API_URL,
  GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
} from "./google-workspace-config.js";

const METADATA_HEADERS = ["From", "Subject", "Date"] as const;

function withCause(error: AppError, cause: unknown): AppError {
  error.cause = cause;
  return error;
}

function unavailable(cause: unknown): AppError {
  return withCause(new AppError(
    "AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE",
    "Не удалось загрузить сведения о письмах из Gmail. Действие не выполнено, повторите запрос позже",
  ), cause);
}

function statusError(status: number): AppError {
  const cause = new Error(`Gmail metadata request failed with HTTP ${status}`);
  if (status === 404) {
    return withCause(new AppError(
      "AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND",
      "Одно из писем не найдено в Gmail — возможно, оно уже удалено или перемещено. Обновите список писем и повторите запрос",
    ), cause);
  }
  if (status === 400) {
    return withCause(new AppError(
      "AGENT_GMAIL_APPROVAL_MESSAGE_ID_INVALID",
      "Gmail не принял идентификатор письма. Обновите список писем и повторите запрос",
    ), cause);
  }
  if (status === 401) {
    return withCause(new AppError(
      "AGENT_GMAIL_APPROVAL_ACCESS_DENIED",
      "Gmail отказал в доступе к письмам. Подключите Google-аккаунт заново",
    ), cause);
  }
  return unavailable(cause);
}

function metadataUrl(messageId: string): string {
  const url = new URL(`${GMAIL_MESSAGES_API_URL}/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of METADATA_HEADERS) url.searchParams.append("metadataHeaders", header);
  return url.toString();
}

export async function fetchGmailMessageMetadata(
  accessToken: string,
  messageId: string,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(metadataUrl(messageId), {
      headers: { authorization: `Bearer ${accessToken}` },
      method: "GET",
      signal: AbortSignal.any([signal, AbortSignal.timeout(GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS)]),
    });
  } catch (cause) {
    // The caller stopped the batch after another message failed; that failure is the one reported.
    if (signal.aborted) throw signal.reason;
    throw unavailable(cause);
  }
  if (!response.ok) {
    // An unread error body would keep the pooled connection busy until garbage collection.
    await response.body?.cancel();
    throw statusError(response.status);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw unavailable(cause);
  }
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw withCause(new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_INVALID",
      "Gmail вернул некорректные сведения о письме. Действие не выполнено",
    ), cause);
  }
}
