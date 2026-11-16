/**
 * Bounded attempts to fetch one file from Telegram: voice notes and the photos and files of a message.
 *
 * Exports:
 * - `TelegramFileAttemptPolicy`: the deadline of one attempt and the number of attempts.
 * - `withTelegramFileAttempts`: runs one fetch under its deadline and repeats it after a stall or a
 *   dropped connection only.
 * - `telegramFetchWithSignal`: a fetch bound to the attempt's signal, so a stalled request ends.
 *
 * Key construct:
 * - Telegram sometimes holds a file request for minutes and then fails it, while the same request a
 *   moment later answers at once: voice notes were lost this way (#498), and on 16.11.2026 `getFile`
 *   for two small photos answered 504 after two minutes, then the same photo in 1.5 s. Only a stall
 *   past the deadline or a lost connection is repeated. Telegram's error answer, an oversized file or
 *   a defect is a verdict a repeat would not change, and the caller's own cancellation is its decision.
 */
import { isAppError } from "./app-error.js";

// How Node's fetch reports a lost connection: on the request, and on a body cut off mid-way.
// Any other TypeError is a defect, which a repeat would only hide.
const FETCH_CONNECTION_FAILURE_MESSAGES = new Set(["fetch failed", "terminated"]);

export interface TelegramFileAttemptPolicy {
  /** How long one attempt may take, from the metadata request to the last byte of the file. */
  readonly attemptTimeoutMs: number;
  /** Attempts in all; only a stalled attempt or a dropped connection leads to the next one. */
  readonly attempts: number;
}

export interface TelegramFileRetry {
  readonly attempt: number;
  readonly cause: string;
  /** Node's fetch names the network failure only on its cause: ECONNRESET, UND_ERR_SOCKET. */
  readonly causeCode: unknown;
}

export async function withTelegramFileAttempts<T>(input: {
  readonly attempt: (signal: AbortSignal) => Promise<T>;
  readonly callerSignal?: AbortSignal;
  /** The caller's error for the final failure, with the original error kept as its cause. */
  readonly fail: (error: unknown) => Error;
  /** Records the repeat; called once before each further attempt. */
  readonly onRetry: (retry: TelegramFileRetry) => void;
  readonly policy: TelegramFileAttemptPolicy;
}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const deadline = AbortSignal.timeout(input.policy.attemptTimeoutMs);
    try {
      return await input.attempt(input.callerSignal ? AbortSignal.any([deadline, input.callerSignal]) : deadline);
    } catch (error) {
      // An AppError is already a verdict on the file itself (Telegram's error answer, an oversized file).
      if (input.callerSignal?.aborted || isAppError(error)) throw error;
      const transient = deadline.aborted
        || (error instanceof TypeError && FETCH_CONNECTION_FAILURE_MESSAGES.has(error.message));
      if (!transient || attempt >= input.policy.attempts) throw input.fail(error);
      input.onRetry({
        attempt,
        cause: error instanceof Error ? error.message : String(error),
        causeCode: error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined,
      });
    }
  }
}

/** The attempt's signal carries its deadline; without it a stalled request would never end. */
export function telegramFetchWithSignal(signal: AbortSignal) {
  return (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
  });
}
