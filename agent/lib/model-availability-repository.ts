/** Persist only real successful model calls. Old or duplicate observations cannot thaw a wait. */
import { AppError } from "./app-error.js";
import { Client } from "pg";

const OBSERVATION_DATABASE_TIMEOUT_MS = 2_000;

export interface SuccessfulModelCall {
  observedAt: Date;
  requestId: string;
  routeKey: string;
}

export async function recordSuccessfulModelCall(input: SuccessfulModelCall): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(input.routeKey) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.requestId) ||
      !(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new AppError("AGENT_MODEL_SUCCESS_INVALID", "Не удалось проверить событие успешного ответа модели");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new AppError("AGENT_DATABASE_CONFIG_MISSING", "Не задано подключение к базе данных");
  // An optional health observation must not wait indefinitely for the application's busy pool.
  const client = new Client({ connectionString, connectionTimeoutMillis: OBSERVATION_DATABASE_TIMEOUT_MS,
    query_timeout: OBSERVATION_DATABASE_TIMEOUT_MS, statement_timeout: OBSERVATION_DATABASE_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO model_availability (route_key, success_version, success_request_id, observed_at)
       VALUES ($1, 1, $2, $3)
       ON CONFLICT (route_key) DO UPDATE
         SET success_version = model_availability.success_version + 1,
             success_request_id = EXCLUDED.success_request_id, observed_at = EXCLUDED.observed_at
       WHERE EXCLUDED.observed_at > model_availability.observed_at
         AND EXCLUDED.success_request_id <> model_availability.success_request_id`,
      [input.routeKey, input.requestId, input.observedAt],
    );
  } finally { await client.end(); }
}
