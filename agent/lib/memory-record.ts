/**
 * Long-term memory record contracts and deterministic projections.
 *
 * Exports:
 * - Memory enums, item, create-input, provenance, evidence, and atomic thread-write types.
 * - `rowToMemory` / `rowToReferencedMemory`: convert PostgreSQL rows to internal records.
 * - `memoryOperationHash`: fingerprints replay-protected mutation input.
 * - `normalizeMemoryClaimContent`: exact-duplicate normalization without semantic heuristics.
 */
import { createHash } from "node:crypto";

import type { MemoryScope } from "./memory-context.js";
import type { ModelMemoryEvidence } from "./model-memory.js";
import type { RememberInput } from "./remember-contract.js";

export type MemoryKind = "episode" | "fact" | "family_shared" | "preference" | "profile";
export type MemoryConfirmation = "model_high" | "user_confirmed";
export type MemorySensitivity = "normal" | "sensitive";
export type MemoryEmbeddingStatus = "failed" | "indexed" | "pending";
export type MemoryThreadEntryRole =
  | "constraint"
  | "decision"
  | "episode"
  | "goal"
  | "lesson"
  | "method"
  | "open_loop"
  | "outcome";

export type CreateMemoryThreadInput = {
  action: "attach";
  role: MemoryThreadEntryRole;
  threadRef: string;
} | {
  action: "create";
  identity?: "project" | "subject";
  parentThreadRef?: string;
  purpose: string;
  role: MemoryThreadEntryRole;
  title: string;
};

export interface MemoryThreadWriteResult {
  action: "attached" | "created";
  threadRef: string;
}

export interface MemoryOperationProvenance {
  sessionId: string;
  turnId: string;
}

export interface MemoryItem {
  /** Short name of the subject's property, when the record holds a slot. */
  attribute: string | null;
  /** Present only when the record is no longer the current one; absent means active. */
  status?: "duplicate" | "retracted" | "superseded";
  /** The day the event happened, as the conversation gave it; null when it was never known. */
  occurredOn: string | null;
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

export interface ReferencedMemoryItem extends MemoryItem {
  memoryRef: string;
  /** Opaque refs of the previous versions this write retired, in the order they were retired. */
  supersededRefs?: string[];
  sourceEvidence?: ModelMemoryEvidence;
  thread?: MemoryThreadWriteResult;
}

export interface CreateMemoryInput {
  memoryReviewBatchId?: string;
  /** Short name of the subject's property this record is about; absent for an episode. */
  attribute?: string;
  /** Refs of the close neighbours the model has read and declared separate from this one. */
  distinctFrom?: readonly string[];
  /** The day the event happened, when the conversation gave it; never guessed. */
  occurredOn?: string;
  confirmation: MemoryConfirmation;
  content: string;
  explicitSource?: CreateMemoryExplicitSourceInput;
  kind: MemoryKind;
  messageThreadId?: string;
  operationKey: string;
  provenance?: MemoryOperationProvenance;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  source: string;
  sourceEventId?: string;
  systemActor?: boolean;
  thread?: CreateMemoryThreadInput;
}

export interface CreateMemoryExplicitSourceInput {
  conversationId: string;
  subject: RememberInput["subject"];
  timelineEntryId: string;
}

export interface MemoryRow {
  attribute: string | null;
  /** Selected only where a reader may see more than the current version. */
  claim_status?: "active" | "duplicate" | "retracted" | "superseded";
  occurred_on?: Date | string | null;
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

export interface ReferencedMemoryRow extends MemoryRow {
  memory_ref: string;
}

/** PostgreSQL hands a `date` back as a local `Date`; only its day is meaningful. */
function memoryEventDay(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

export function rowToMemory(row: MemoryRow): MemoryItem {
  return {
    attribute: row.attribute ?? null,
    occurredOn: memoryEventDay(row.occurred_on),
    ...(row.claim_status === undefined || row.claim_status === "active"
      ? {}
      : { status: row.claim_status }),
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

export function rowToReferencedMemory(row: ReferencedMemoryRow): ReferencedMemoryItem {
  return {
    ...rowToMemory(row),
    memoryRef: row.memory_ref,
  };
}

export function memoryOperationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeMemoryClaimContent(content: string): string {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
