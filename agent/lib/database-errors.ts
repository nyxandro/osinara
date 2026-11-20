/** Connection classification is attached at the PostgreSQL adapter, not to arbitrary network failures. */
import { AppError } from "./app-error.js";
const POSTGRES_UNAVAILABLE = new Set(["08000","08001","08003","08004","08006","08007","08P01","57P01","57P02","57P03","53300"]);
// The last two are pg-pool 3.14's own errors, raised without a code before any query reaches the server: no
// connection was handed out in time, or a new one did not open in time (#559). Waiting and retrying is safe.
const PG_CONNECTION_MESSAGES = new Set(["Connection terminated unexpectedly","Connection terminated","Client has encountered a connection error and is not queryable",
  "timeout exceeded when trying to connect","Connection terminated due to connection timeout"]);
const SOCKET_CODES = new Set(["ECONNRESET","ECONNREFUSED","EPIPE","EHOSTUNREACH","ENETUNREACH","ETIMEDOUT"]);

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "AGENT_DATABASE_UNAVAILABLE" || typeof code === "string" && POSTGRES_UNAVAILABLE.has(code) || PG_CONNECTION_MESSAGES.has(error.message)) return true;
  if (error instanceof AggregateError && error.errors.some(isDatabaseUnavailable)) return true;
  return error.cause !== error && isDatabaseUnavailable(error.cause);
}

export function normalizePostgresError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof AppError) return error;
  const code = "code" in error ? error.code : undefined;
  if (!isDatabaseUnavailable(error) && !(typeof code === "string" && SOCKET_CODES.has(code))) return error;
  const failure = new AppError("AGENT_DATABASE_UNAVAILABLE", "Соединение с базой данных прервано. Обработка ожидает восстановления");
  failure.cause = error;
  return failure;
}

/** The adapter's mark of a transaction whose ROLLBACK failed after a broken connection (`database-client.ts`). */
const ROLLBACK_FAILED = "AGENT_DATABASE_ROLLBACK_FAILED";

/**
 * Whether a failure leaves a write's outcome unknown: the connection broke while the transaction ended, so its
 * COMMIT may have been applied (#539). Tools wrap storage errors in their own, so the whole chain is read.
 */
export function isStorageOutcomeUnknown(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8) return false;
  if (error.message === ROLLBACK_FAILED || ("code" in error && error.code === ROLLBACK_FAILED)) return true;
  return error.cause !== error && isStorageOutcomeUnknown(error.cause, depth + 1);
}
