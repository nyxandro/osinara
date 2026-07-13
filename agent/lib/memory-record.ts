/**
 * Long-term memory record contracts and deterministic projections.
 *
 * Exports:
 * - Memory enums, item, row, and create-input types.
 * - `rowToMemory`: converts PostgreSQL rows to model-safe records.
 * - `memoryOperationHash`: fingerprints replay-protected mutation input.
 */
import { createHash } from "node:crypto";

import type { MemoryScope } from "./memory-context.js";

export type MemoryKind = "episode" | "fact" | "family_shared" | "preference" | "profile";
export type MemoryConfirmation = "model_high" | "user_confirmed";
export type MemorySensitivity = "normal" | "sensitive";
export type MemoryEmbeddingStatus = "failed" | "indexed" | "pending";

export interface MemoryItem {
  author: {
    status: "current_member" | "former_member" | "telegram_user";
    telegramUserId: string | null;
    userId: string | null;
  };
  confirmation: MemoryConfirmation;
  content: string;
  createdAt: string;
  embeddingStatus: MemoryEmbeddingStatus;
  id: string;
  kind: MemoryKind;
  messageThreadId: string | null;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  source: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  confirmation: MemoryConfirmation;
  content: string;
  kind: MemoryKind;
  messageThreadId?: string;
  operationKey: string;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  source: string;
  sourceEventId?: string;
}

export interface MemoryRow {
  author_telegram_user_id: string | null;
  author_user_id: string | null;
  confirmation: MemoryConfirmation;
  content: string;
  created_at: Date;
  embedding_status: MemoryEmbeddingStatus;
  id: string;
  kind: MemoryKind;
  message_thread_id: string | null;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  source: string;
  updated_at: Date;
}

export function rowToMemory(row: MemoryRow): MemoryItem {
  return {
    author: {
      status:
        row.scope === "group"
          ? "telegram_user"
          : row.author_user_id
            ? "current_member"
            : "former_member",
      telegramUserId: row.author_telegram_user_id,
      userId: row.author_user_id,
    },
    confirmation: row.confirmation,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    embeddingStatus: row.embedding_status,
    id: row.id,
    kind: row.kind,
    messageThreadId: row.message_thread_id,
    scope: row.scope,
    sensitivity: row.sensitivity,
    source: row.source,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function memoryOperationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
