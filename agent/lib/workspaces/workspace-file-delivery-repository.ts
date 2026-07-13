/**
 * Durable workspace-file delivery reservation.
 *
 * Exports:
 * - `WorkspaceFileDeliveryReservation`: reserved bytes or a completed replay.
 * - `createWorkspaceFileDeliveryRepository`: PostgreSQL idempotence around external delivery.
 * - `workspaceFileDeliveryRepository`: production repository.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { WorkspaceBinaryFile } from "./workspace-binary-repository.js";
import { workspaceBinaryRepository } from "./workspace-binary-repository.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspace-repository.js";

interface BinaryReader {
  readBinary(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    path: string,
  ): Promise<WorkspaceBinaryFile>;
}

interface DeliveryRow {
  content_sha256: string;
  file_path: string;
  presentation: "document" | "photo";
  requested_by: string | null;
  status: "completed" | "failed" | "started";
  telegram_chat_id: string;
  telegram_message_id: string | null;
  telegram_message_thread_id: string | null;
  workspace_id: string;
}

export type WorkspaceFileDeliveryReservation =
  | { status: "completed"; telegramMessageId: string }
  | ({ status: "reserved" } & WorkspaceBinaryFile);

function threadId(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function assertReplayMatches(
  row: DeliveryRow,
  auth: WorkspaceAuthorization,
  binary: WorkspaceBinaryFile,
  input: {
    chatId: string;
    messageThreadId?: number;
    presentation: "document" | "photo";
  },
): void {
  const matches = row.workspace_id === binary.workspaceId &&
    row.file_path === binary.file.path &&
    row.content_sha256 === binary.file.contentSha256 &&
    row.requested_by === auth.userId &&
    row.telegram_chat_id === input.chatId &&
    row.telegram_message_thread_id === threadId(input.messageThreadId) &&
    row.presentation === input.presentation;
  if (!matches) {
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_REPLAY_MISMATCH",
      "Повтор отправки не совпадает с исходным запросом",
    );
  }
}

export function createWorkspaceFileDeliveryRepository(binaryReader: BinaryReader) {
  return {
    async begin(auth: WorkspaceAuthorization, input: {
      chatId: string;
      messageThreadId?: number;
      operationKey: string;
      path: string;
      presentation: "document" | "photo";
      scope: WorkspaceScope;
    }): Promise<WorkspaceFileDeliveryReservation> {
      // Read authorization and an immutable byte snapshot before reserving the external side effect.
      const binary = await binaryReader.readBinary(auth, input.scope, input.path);
      const inserted = await database().query(
        `INSERT INTO workspace_file_deliveries
            (family_id, workspace_id, file_path, content_sha256, operation_key, requested_by,
             telegram_chat_id, telegram_message_thread_id, presentation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (operation_key) DO NOTHING`,
        [
          auth.familyId,
          binary.workspaceId,
          binary.file.path,
          binary.file.contentSha256,
          input.operationKey,
          auth.userId,
          input.chatId,
          input.messageThreadId ?? null,
          input.presentation,
        ],
      );
      if (inserted.rowCount === 1) return { ...binary, status: "reserved" };

      const existing = await database().query<DeliveryRow>(
        `SELECT workspace_id, file_path, content_sha256, requested_by, telegram_chat_id,
                telegram_message_thread_id::text, presentation, status, telegram_message_id
           FROM workspace_file_deliveries WHERE operation_key = $1`,
        [input.operationKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("AGENT_WORKSPACE_FILE_DELIVERY_STATE_MISSING");
      assertReplayMatches(row, auth, binary, input);
      if (row.status === "completed" && row.telegram_message_id) {
        return { status: "completed", telegramMessageId: row.telegram_message_id };
      }
      if (row.status === "started") {
        throw new AppError(
          "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
          "Не удалось подтвердить прошлую отправку. Проверьте файл в чате перед новым запросом",
        );
      }
      throw new AppError(
        "AGENT_WORKSPACE_FILE_DELIVERY_PREVIOUSLY_FAILED",
        "Прошлая отправка завершилась ошибкой. Создайте новый запрос",
      );
    },

    async complete(operationKey: string, telegramMessageId: string): Promise<void> {
      const result = await database().query(
        `UPDATE workspace_file_deliveries
            SET status = 'completed', telegram_message_id = $2, completed_at = now()
          WHERE operation_key = $1 AND status = 'started'`,
        [operationKey, telegramMessageId],
      );
      if (result.rowCount !== 1) {
        throw new Error("AGENT_WORKSPACE_FILE_DELIVERY_STATE_INVALID: Delivery was not started");
      }
    },

    async fail(operationKey: string, failureCode: string): Promise<void> {
      await database().query(
        `UPDATE workspace_file_deliveries SET status = 'failed', failure_code = $2
          WHERE operation_key = $1 AND status = 'started'`,
        [operationKey, failureCode],
      );
    },
  };
}

export const workspaceFileDeliveryRepository = createWorkspaceFileDeliveryRepository(
  workspaceBinaryRepository,
);
