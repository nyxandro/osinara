/**
 * Bounded model-safe memory-thread context assembly.
 *
 * Exports:
 * - `ActivatedMemoryThread`: source-backed repository projection before global budgeting.
 * - `MemoryThreadContext`: allowlisted model-facing thread payload without database identity.
 * - `assembleMemoryThreadContext`: signal ordering, whole-item budgets, and cross-thread deduplication.
 */
import {
  THREAD_BRIEF_MAX_CHARACTERS,
  THREAD_BRIEF_MAX_ITEMS,
  THREAD_CONTEXT_EPISODES_PER_THREAD,
  THREAD_CONTEXT_MAX_CHARACTERS,
  THREAD_CONTEXT_MAX_THREADS,
  THREAD_EPISODE_MAX_CHARACTERS,
} from "./memory-config.js";
import type { MemoryThreadBriefBlock } from "./memory-thread-brief-generator.js";
import type { MemoryThreadSourceEvidence } from "./memory-thread-source-evidence.js";

type ModelThreadBlock = MemoryThreadBriefBlock & {
  sourceEvidence: MemoryThreadSourceEvidence[];
};

type ModelThreadEpisode = {
  content: string;
  sourceEntryRefs: string[];
  sourceEvidence: MemoryThreadSourceEvidence[];
};

export interface ActivatedMemoryThread {
  blocks: readonly MemoryThreadBriefBlock[];
  completionEpisode?: { content: string; sourceEntryRefs: string[]; sourceRecordRefs?: string[] };
  episodes: readonly { content: string; sourceEntryRefs: string[]; sourceRecordRefs?: string[] }[];
  purpose: string;
  relevance: { retrievalHits: number; skillHint: boolean; titleMatch: boolean };
  sourceEvidence: readonly MemoryThreadSourceEvidence[];
  status: "active" | "completed";
  threadRef: string;
  title: string;
}

export interface MemoryThreadContext {
  threads: Array<{
    blocks?: ModelThreadBlock[];
    completionEpisode?: ModelThreadEpisode;
    episodes?: ModelThreadEpisode[];
    purpose: string;
    status: "active" | "completed";
    threadRef: string;
    title: string;
  }>;
  totalCharacters: number;
}

function relevanceOrder(left: ActivatedMemoryThread, right: ActivatedMemoryThread): number {
  if (left.relevance.skillHint !== right.relevance.skillHint) return left.relevance.skillHint ? -1 : 1;
  if (left.relevance.titleMatch !== right.relevance.titleMatch) return left.relevance.titleMatch ? -1 : 1;
  if (left.relevance.retrievalHits !== right.relevance.retrievalHits) {
    return right.relevance.retrievalHits - left.relevance.retrievalHits;
  }
  return left.threadRef.localeCompare(right.threadRef);
}

function blockCharacters(block: MemoryThreadBriefBlock): number {
  return block.content.length;
}

function sourceEvidenceFor(
  refs: readonly string[],
  evidence: readonly MemoryThreadSourceEvidence[],
): MemoryThreadSourceEvidence[] {
  const selected = new Set(refs);
  return evidence.filter((item) => selected.has(item.sourceEntryRef));
}

function sourceEvidenceCharacters(evidence: readonly MemoryThreadSourceEvidence[]): number {
  return evidence.reduce((total, item) => total + item.sourceEntryRef.length +
    item.authorLabel.length + item.kind.length + item.observedAt.length, 0);
}

export function assembleMemoryThreadContext(
  candidates: readonly ActivatedMemoryThread[],
): MemoryThreadContext {
  const selected = [...candidates].sort(relevanceOrder).slice(0, THREAD_CONTEXT_MAX_THREADS);
  const seenEntryRefs = new Set<string>();
  const seenSourceRecords = new Set<string>();
  const threads: MemoryThreadContext["threads"] = [];
  let totalCharacters = 0;

  for (const thread of selected) {
    const baseCharacters = thread.title.length + thread.purpose.length;
    if (totalCharacters + baseCharacters > THREAD_CONTEXT_MAX_CHARACTERS) continue;
    const projected: MemoryThreadContext["threads"][number] = {
      purpose: thread.purpose,
      status: thread.status,
      threadRef: thread.threadRef,
      title: thread.title,
    };
    let threadCharacters = baseCharacters;

    // Completed subthreads contribute only their compact completion episode during ordinary loading.
    if (thread.status === "completed") {
      const completion = thread.completionEpisode;
      const completionEvidence = completion
        ? sourceEvidenceFor(completion.sourceEntryRefs, thread.sourceEvidence)
        : [];
      const completionCharacters = completion
        ? completion.content.length + sourceEvidenceCharacters(completionEvidence)
        : 0;
      if (!completion || completion.content.length > THREAD_EPISODE_MAX_CHARACTERS ||
        completion.sourceEntryRefs.some((ref) => seenEntryRefs.has(ref)) ||
        completion.sourceRecordRefs?.some((ref) => seenSourceRecords.has(ref)) ||
        totalCharacters + threadCharacters + completionCharacters > THREAD_CONTEXT_MAX_CHARACTERS) {
        continue;
      }
      const { sourceRecordRefs: _sourceRecordRefs, ...modelCompletion } = completion;
      projected.completionEpisode = {
        ...modelCompletion,
        sourceEvidence: completionEvidence,
      };
      completion.sourceEntryRefs.forEach((ref) => seenEntryRefs.add(ref));
      completion.sourceRecordRefs?.forEach((ref) => seenSourceRecords.add(ref));
      threadCharacters += completionCharacters;
      threads.push(projected);
      totalCharacters += threadCharacters;
      continue;
    }

    const blocks: ModelThreadBlock[] = [];
    let briefCharacters = 0;
    for (const block of thread.blocks.slice(0, THREAD_BRIEF_MAX_ITEMS)) {
      if (block.sourceEntryRefs.some((ref) => seenEntryRefs.has(ref)) ||
        block.sourceRecordRefs?.some((ref) => seenSourceRecords.has(ref))) continue;
      const blockEvidence = sourceEvidenceFor(block.sourceEntryRefs, thread.sourceEvidence);
      const characters = blockCharacters(block) + sourceEvidenceCharacters(blockEvidence);
      if (briefCharacters + characters > THREAD_BRIEF_MAX_CHARACTERS ||
        totalCharacters + threadCharacters + characters > THREAD_CONTEXT_MAX_CHARACTERS) continue;
      const { sourceRecordRefs: _sourceRecordRefs, ...modelBlock } = block;
      blocks.push({
        ...modelBlock,
        sourceEvidence: blockEvidence,
      });
      briefCharacters += characters;
      threadCharacters += characters;
      block.sourceEntryRefs.forEach((ref) => seenEntryRefs.add(ref));
      block.sourceRecordRefs?.forEach((ref) => seenSourceRecords.add(ref));
    }
    if (blocks.length > 0) projected.blocks = blocks;

    const episodes: ModelThreadEpisode[] = [];
    for (const episode of thread.episodes.slice(0, THREAD_CONTEXT_EPISODES_PER_THREAD)) {
      const episodeEvidence = sourceEvidenceFor(episode.sourceEntryRefs, thread.sourceEvidence);
      const episodeCharacters = episode.content.length + sourceEvidenceCharacters(episodeEvidence);
      if (episode.content.length > THREAD_EPISODE_MAX_CHARACTERS ||
        episode.sourceEntryRefs.some((ref) => seenEntryRefs.has(ref)) ||
        episode.sourceRecordRefs?.some((ref) => seenSourceRecords.has(ref)) ||
        totalCharacters + threadCharacters + episodeCharacters > THREAD_CONTEXT_MAX_CHARACTERS) continue;
      const { sourceRecordRefs: _sourceRecordRefs, ...modelEpisode } = episode;
      episodes.push({
        ...modelEpisode,
        sourceEvidence: episodeEvidence,
      });
      threadCharacters += episodeCharacters;
      episode.sourceEntryRefs.forEach((ref) => seenEntryRefs.add(ref));
      episode.sourceRecordRefs?.forEach((ref) => seenSourceRecords.add(ref));
    }
    if (episodes.length > 0) projected.episodes = episodes;
    threads.push(projected);
    totalCharacters += threadCharacters;
  }
  return { threads, totalCharacters };
}
