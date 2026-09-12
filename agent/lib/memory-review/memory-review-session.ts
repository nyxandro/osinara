/**
 * Memory-review Eve session identification.
 *
 * Exports:
 * - `memoryReviewBatchId`: validates the optional trusted batch marker.
 * - `memoryReviewBatchIdFromContinuationToken`: resolves context-free internal failures.
 * - `isMemoryReviewSession`: identifies only internal background review turns.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";

const REVIEW_CONTINUATION_PATTERN = /^memory-review:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?::attempt:[1-9]\d*)?$/iu;

export function reviewContinuationToken(batchId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new AppError(
    "AGENT_MEMORY_REVIEW_GENERATION_INVALID", "Не удалось определить номер попытки проверки памяти",
  );
  // Generation zero preserves shipped continuation tokens; every recovery gets a fresh one.
  return generation === 0 ? `memory-review:${batchId}` : `memory-review:${batchId}:attempt:${generation}`;
}

export function memoryReviewBatchIdFromContinuationToken(token: string): string | null {
  return REVIEW_CONTINUATION_PATTERN.exec(token)?.[1] ?? null;
}

export function memoryReviewBatchId(
  ctx: { session: { auth: SessionContext["session"]["auth"] } },
): string | null {
  const value = ctx.session.auth.current?.attributes.memoryReviewBatchId;
  if (value === undefined) return null;
  if (typeof value !== "string" || !value) {
    throw new AppError(
      "AGENT_MEMORY_REVIEW_CONTEXT_INVALID",
      "Не удалось определить пакет проверки памяти",
    );
  }
  return value;
}

export function isMemoryReviewSession(
  ctx: { session: { auth: SessionContext["session"]["auth"] } },
): boolean {
  const mode = ctx.session.auth.current?.attributes.memoryReviewMode;
  if (mode === undefined) return false;
  if (mode !== "background" && mode !== "interactive") {
    throw new AppError(
      "AGENT_MEMORY_REVIEW_CONTEXT_INVALID",
      "Не удалось определить режим проверки памяти",
    );
  }
  return mode === "background";
}
