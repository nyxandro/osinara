/** Connection classification is attached at the PostgreSQL adapter, not to arbitrary network failures. */
import { AppError } from "./app-error.js";
const POSTGRES_UNAVAILABLE = new Set(["08000","08001","08003","08004","08006","08007","08P01","57P01","57P02","57P03","53300"]);
const PG_CONNECTION_MESSAGES = new Set(["Connection terminated unexpectedly","Connection terminated","Client has encountered a connection error and is not queryable"]);
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
