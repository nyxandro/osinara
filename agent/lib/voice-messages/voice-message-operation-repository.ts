/**
 * Durable exactly-once ledger for billable ElevenLabs voice message synthesis.
 *
 * Exports:
 * - `VoiceMessageReservation`: execute, replay, in-flight, or terminal failure state.
 * - `voiceMessageOperationRepository`: reserves and settles one billable call ID.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";

interface OperationRow {
  error_code: string | null;
  input_hash: string;
  output_path: string;
  result: WorkspaceFileRecord | null;
  status: "ambiguous" | "completed" | "failed" | "started";
  workspace_id: string;
}

export type VoiceMessageReservation =
  | { state: "execute"; workspaceId: string }
  | { file: WorkspaceFileRecord; state: "completed" }
  | { state: "started"; workspaceId: string }
  | { errorCode: string; state: "ambiguous" | "failed" };

function invalidState(operationKey: string, reason: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_VOICE_MESSAGE_STATE_INVALID", operationKey, reason }));
  return new AppError(
    "AGENT_VOICE_MESSAGE_STATE_INVALID",
    "Не удалось восстановить состояние голосового сообщения. Попросите голосовое заново",
  );
}

async function settleFailure(
  operationKey: string,
  status: "ambiguous" | "failed",
  errorCode: string,
): Promise<void> {
  const result = await database().query(
    `UPDATE voice_message_operations
        SET status = $2, error_code = $3, updated_at = now(), completed_at = now()
      WHERE operation_key = $1 AND status = 'started'`,
    [operationKey, status, errorCode],
  );
  if (result.rowCount !== 1) {
    throw invalidState(operationKey, "failure settlement requires a started operation");
  }
}

export const voiceMessageOperationRepository = {
  async begin(input: {
    inputHash: string;
    operationKey: string;
    outputPath: string;
    workspaceId: string;
  }): Promise<VoiceMessageReservation> {
    const inserted = await database().query(
      `INSERT INTO voice_message_operations
         (operation_key, workspace_id, input_hash, output_path)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_key) DO NOTHING`,
      [input.operationKey, input.workspaceId, input.inputHash, input.outputPath],
    );
    if (inserted.rowCount === 1) return { state: "execute", workspaceId: input.workspaceId };

    const existing = await database().query<OperationRow>(
      `SELECT workspace_id, input_hash, output_path, status, result, error_code
         FROM voice_message_operations
        WHERE operation_key = $1`,
      [input.operationKey],
    );
    const row = existing.rows[0];
    if (!row) throw invalidState(input.operationKey, "reserved operation is missing");
    if (
      row.workspace_id !== input.workspaceId ||
      row.input_hash !== input.inputHash ||
      row.output_path !== input.outputPath
    ) {
      throw new AppError(
        "AGENT_VOICE_MESSAGE_REPLAY_MISMATCH",
        "Повтор голосового сообщения не совпадает с исходным запросом. Попросите голосовое заново",
      );
    }
    if (row.status === "completed") {
      if (!row.result) throw invalidState(input.operationKey, "completed operation has no result");
      return { file: row.result, state: "completed" };
    }
    if (row.status === "started") return { state: "started", workspaceId: row.workspace_id };
    if (!row.error_code) throw invalidState(input.operationKey, "terminal operation has no error code");
    return { errorCode: row.error_code, state: row.status };
  },

  async complete(
    operationKey: string,
    file: WorkspaceFileRecord,
    characterCost: number | null,
  ): Promise<void> {
    const result = await database().query(
      `UPDATE voice_message_operations
          SET status = 'completed', result = $2, character_cost = $3,
              updated_at = now(), completed_at = now()
        WHERE operation_key = $1 AND status = 'started'`,
      [operationKey, JSON.stringify(file), characterCost],
    );
    if (result.rowCount !== 1) {
      throw invalidState(operationKey, "completion requires a started operation");
    }
  },

  async markAmbiguous(operationKey: string, errorCode: string): Promise<void> {
    await settleFailure(operationKey, "ambiguous", errorCode);
  },

  async markFailed(operationKey: string, errorCode: string): Promise<void> {
    await settleFailure(operationKey, "failed", errorCode);
  },
};
