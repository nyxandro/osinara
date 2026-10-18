/**
 * Application-owned memory-thread activation signals.
 *
 * Exports:
 * - `applicationThreadSkillHints`: maps reviewed skill calls to broad thread titles.
 * - `selectMemoryThreadActivationCandidates`: requires authorization before any activation signal.
 */
import type { ModelMessage } from "ai";

import { THREAD_TITLE_MIN_SEMANTIC_SIMILARITY } from "./memory-config.js";

interface ThreadActivationCandidate {
  authorized: boolean;
  originScope: "family" | "group" | "personal";
  retrievalHits: number;
  skillHint: boolean;
  titleSimilarity: number | null;
}

// Empty since the built-in t-invest skill was removed: no reviewed skill maps to a thread now.
const REVIEWED_SKILL_THREAD_HINTS: Readonly<Record<string, string>> = {};

export function applicationThreadSkillHints(messages: readonly ModelMessage[]): string[] {
  const hints = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (typeof part !== "object" || part === null) continue;
      const call = part as { input?: unknown; toolName?: unknown; type?: unknown };
      if (call.type !== "tool-call" || call.toolName !== "load_skill" ||
        typeof call.input !== "object" || call.input === null) continue;
      const input = call.input as { skill?: unknown; skillId?: unknown };
      const skill = typeof input.skill === "string" ? input.skill : input.skillId;
      if (typeof skill !== "string") continue;
      const hint = REVIEWED_SKILL_THREAD_HINTS[skill];
      if (hint) hints.add(hint);
    }
  }
  return [...hints];
}

export function selectMemoryThreadActivationCandidates<T extends ThreadActivationCandidate>(
  candidates: readonly T[],
): T[] {
  // Authorization is evaluated first, so inward-projected external claims cannot activate their origin thread.
  return candidates.filter((candidate) => candidate.authorized && (
    candidate.skillHint || candidate.retrievalHits > 0 ||
    (candidate.titleSimilarity !== null &&
      candidate.titleSimilarity >= THREAD_TITLE_MIN_SEMANTIC_SIMILARITY)
  ));
}
