/**
 * Deterministic source-backed memory-thread brief builder.
 *
 * Exports:
 * - Brief source/block contracts shared by source loading and context assembly.
 * - `buildMemoryThreadBrief`: copies bounded source records into role-ordered blocks without an LLM.
 */
import {
  THREAD_BRIEF_MAX_CHARACTERS,
  THREAD_BRIEF_MAX_ITEMS,
  THREAD_CONTEXT_EPISODES_PER_THREAD,
  THREAD_EPISODE_MAX_CHARACTERS,
} from "./memory-config.js";
import type { MemoryThreadEntryRole } from "./memory-record.js";
import type { ModelMemoryEvidence } from "./model-memory.js";

export const THREAD_BRIEF_BLOCK_KINDS = [
  "constraints_conflicts",
  "active_goals_open_loops",
  "method",
  "decisions_outcomes",
  "lessons",
  "episodes",
] as const;
export type MemoryThreadBriefBlockKind = (typeof THREAD_BRIEF_BLOCK_KINDS)[number];

export interface MemoryThreadBriefSource {
  content: string;
  evidence: ModelMemoryEvidence;
  occurredAt: string;
  ref: string;
  role: MemoryThreadEntryRole;
  sourceRef: string;
}

export interface MemoryThreadBriefBlock {
  content: string;
  kind: MemoryThreadBriefBlockKind;
  sourceEntryRefs: string[];
  /** Internal dedup keys; the model-facing assembler strips this field. */
  sourceRecordRefs?: string[];
}

const BLOCK_KIND_BY_ROLE: Readonly<Record<MemoryThreadEntryRole, MemoryThreadBriefBlockKind>> = {
  constraint: "constraints_conflicts",
  decision: "decisions_outcomes",
  episode: "episodes",
  goal: "active_goals_open_loops",
  lesson: "lessons",
  method: "method",
  open_loop: "active_goals_open_loops",
  outcome: "decisions_outcomes",
};

/**
 * Sources are immutable verified records. Copying them verbatim keeps every assertion cited and
 * avoids spending another model call to reinterpret text the main chat agent has already handled.
 */
export function buildMemoryThreadBrief(input: {
  entries: readonly MemoryThreadBriefSource[];
}): MemoryThreadBriefBlock[] {
  const ordered = [...input.entries].sort((left, right) => {
    const priority = THREAD_BRIEF_BLOCK_KINDS.indexOf(BLOCK_KIND_BY_ROLE[left.role]) -
      THREAD_BRIEF_BLOCK_KINDS.indexOf(BLOCK_KIND_BY_ROLE[right.role]);
    return priority !== 0 ? priority : right.occurredAt.localeCompare(left.occurredAt);
  });
  const blocks: MemoryThreadBriefBlock[] = [];
  let characters = 0;
  let episodes = 0;

  // Budgets skip oversized records whole; source text is never truncated or synthesized.
  for (const source of ordered) {
    const kind = BLOCK_KIND_BY_ROLE[source.role];
    if (source.content.length > THREAD_BRIEF_MAX_CHARACTERS ||
      characters + source.content.length > THREAD_BRIEF_MAX_CHARACTERS) continue;
    if (kind === "episodes" && (source.content.length > THREAD_EPISODE_MAX_CHARACTERS ||
      episodes >= THREAD_CONTEXT_EPISODES_PER_THREAD)) continue;
    blocks.push({ content: source.content, kind, sourceEntryRefs: [source.ref] });
    characters += source.content.length;
    if (kind === "episodes") episodes += 1;
    if (blocks.length >= THREAD_BRIEF_MAX_ITEMS) break;
  }
  return blocks;
}
