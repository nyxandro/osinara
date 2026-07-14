/**
 * Durable Google Workspace mutation replay boundary.
 *
 * Export:
 * - `googleOperationRepository`: reserves exact user requests and returns completed replays.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";

const GOOGLE_WORKSPACE_PROVIDER = "google_workspace";
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/u;

interface GoogleOperationIdentity {
  operationKey: string;
  requestHash: string;
}

interface OperationRow<T> {
  family_id: string;
  request_hash: string;
  result: T | null;
  status: "completed" | "started";
  user_id: string;
}

function validateIdentity(input: GoogleOperationIdentity): void {
  if (
    !input.operationKey ||
    input.operationKey.length > 512 ||
    !REQUEST_HASH_PATTERN.test(input.requestHash)
  ) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_OPERATION_INVALID",
      "Не удалось создать безопасный идентификатор операции Google Workspace",
    );
  }
}

export const googleOperationRepository = {
  async begin<T>(
    auth: GoogleIntegrationAuthorization,
    input: GoogleOperationIdentity,
  ): Promise<{ status: "started" } | { result: T; status: "completed" }> {
    validateIdentity(input);
    const inserted = await database().query(
      `INSERT INTO integration_operations
         (operation_key, family_id, user_id, provider, request_hash, status)
       SELECT $1, $2, $3, $4, $5, 'started'
       WHERE EXISTS (
         SELECT 1 FROM family_memberships WHERE family_id = $2 AND user_id = $3
       )
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING operation_key`,
      [input.operationKey, auth.familyId, auth.userId, GOOGLE_WORKSPACE_PROVIDER, input.requestHash],
    );
    if (inserted.rowCount) return { status: "started" };

    // A conflict is reusable only for the same user and byte-identical logical request.
    const existing = await database().query<OperationRow<T>>(
      `SELECT family_id, user_id, request_hash, status, result
       FROM integration_operations WHERE operation_key = $1 AND provider = $2`,
      [input.operationKey, GOOGLE_WORKSPACE_PROVIDER],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.family_id !== auth.familyId ||
      row.user_id !== auth.userId ||
      row.request_hash !== input.requestHash
    ) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_OPERATION_CONFLICT",
        "Идентификатор операции Google Workspace уже использован другим запросом",
      );
    }
    if (row.status === "completed" && row.result !== null) {
      return { result: row.result, status: "completed" };
    }
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_OPERATION_AMBIGUOUS",
      "Предыдущая операция Google Workspace завершилась неоднозначно и не будет повторена автоматически. Проверьте результат в Google перед новым запросом",
    );
  },

  async complete<T>(
    auth: GoogleIntegrationAuthorization,
    input: GoogleOperationIdentity,
    result: T,
  ): Promise<void> {
    validateIdentity(input);
    const serialized = JSON.stringify(result);
    if (serialized === undefined) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_OPERATION_RESULT_INVALID",
        "Google Workspace вернул результат, который нельзя безопасно сохранить",
      );
    }
    const updated = await database().query(
      `UPDATE integration_operations
       SET status = 'completed', result = $6::jsonb, completed_at = now()
       WHERE operation_key = $1 AND family_id = $2 AND user_id = $3
         AND provider = $4 AND request_hash = $5 AND status = 'started'`,
      [
        input.operationKey,
        auth.familyId,
        auth.userId,
        GOOGLE_WORKSPACE_PROVIDER,
        input.requestHash,
        serialized,
      ],
    );
    if (!updated.rowCount) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_OPERATION_CONFLICT",
        "Не удалось зафиксировать результат операции Google Workspace",
      );
    }
  },
};
