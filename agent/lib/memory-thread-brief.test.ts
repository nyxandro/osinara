/**
 * Live memory-thread brief generation and context-budget tests.
 *
 * Constructs covered:
 * - Deterministic blocks copy supplied source records and follow the fixed priority order.
 * - Brief item/character and per-episode limits keep whole records instead of truncating them.
 * - Shared entries are rendered once when two activated threads overlap.
 * - Building a brief has no model/provider dependency.
 */
import { describe, expect, it } from "vitest";

import {
  assembleMemoryThreadContext,
  type ActivatedMemoryThread,
} from "./memory-thread-context.js";
import { buildMemoryThreadBrief } from "./memory-thread-brief-generator.js";

const SOURCE = {
  content: "Тренироваться не чаще трёх раз в неделю",
  evidence: {
    authorLabel: "Анна",
    kind: "reported" as const,
    notice: "Сообщено другим участником; не является подтверждением субъекта.",
    observedAt: "2026-08-01T10:00:00.000Z",
  },
  occurredAt: "2026-08-01T10:00:00.000Z",
  ref: "entry_a",
  role: "constraint" as const,
  sourceRef: "mem_0123456789abcdef0123456789abcdef",
};

describe("memory thread brief generator", () => {
  it("copies source-backed records into ordered deterministic blocks", () => {
    expect(buildMemoryThreadBrief({
      entries: [{ ...SOURCE, ref: "entry_method", role: "method" }, SOURCE],
    })).toEqual([
      { content: SOURCE.content, kind: "constraints_conflicts", sourceEntryRefs: [SOURCE.ref] },
      { content: SOURCE.content, kind: "method", sourceEntryRefs: ["entry_method"] },
    ]);
  });

  it("keeps whole records inside the brief and episode budgets", () => {
    const oversized = { ...SOURCE, content: "x".repeat(6_001), ref: "entry_oversized" };
    const episode = {
      ...SOURCE,
      content: "y".repeat(2_001),
      ref: "entry_episode",
      role: "episode" as const,
    };

    expect(buildMemoryThreadBrief({ entries: [oversized, episode, SOURCE] })).toEqual([
      { content: SOURCE.content, kind: "constraints_conflicts", sourceEntryRefs: [SOURCE.ref] },
    ]);
  });

});

function thread(overrides: Partial<ActivatedMemoryThread> = {}): ActivatedMemoryThread {
  return {
    blocks: [{ content: SOURCE.content, kind: "constraints_conflicts", sourceEntryRefs: [SOURCE.ref] }],
    episodes: [],
    purpose: "Сохранять решения и результаты",
    relevance: { retrievalHits: 1, skillHint: false, titleMatch: false },
    sourceEvidence: [{ ...SOURCE.evidence, sourceEntryRef: SOURCE.ref }],
    status: "active",
    threadRef: "thread_0123456789abcdef0123456789abcdef",
    title: "Тренировки",
    ...overrides,
  };
}

describe("memory thread context assembly", () => {
  it("prioritizes skill, title, and retrieval hits and caps context at two threads", () => {
    const context = assembleMemoryThreadContext([
      thread({ threadRef: "thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", relevance: { retrievalHits: 9, skillHint: false, titleMatch: false } }),
      thread({ threadRef: "thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", relevance: { retrievalHits: 1, skillHint: false, titleMatch: true } }),
      thread({ threadRef: "thread_cccccccccccccccccccccccccccccccc", relevance: { retrievalHits: 0, skillHint: true, titleMatch: false } }),
    ]);

    expect(context.threads.map((item) => item.threadRef)).toEqual([
      "thread_cccccccccccccccccccccccccccccccc",
      "thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    expect(context.totalCharacters).toBeLessThanOrEqual(16_000);
  });

  it("deduplicates one source entry across simultaneously activated threads", () => {
    const context = assembleMemoryThreadContext([
      thread(),
      thread({ threadRef: "thread_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "Бег" }),
    ]);

    const serialized = JSON.stringify(context);
    expect(serialized.match(new RegExp(SOURCE.content, "gu"))).toHaveLength(1);
    expect(serialized).not.toMatch(/"(?:id|familyId|userId|groupId|scopePartitionKey)"/u);
    expect(context.threads[0]?.blocks?.[0]?.sourceEvidence).toEqual([
      { ...SOURCE.evidence, sourceEntryRef: SOURCE.ref },
    ]);
  });

  it("represents a completed subthread by its completion episode during ordinary activation", () => {
    const context = assembleMemoryThreadContext([thread({
      blocks: [],
      completionEpisode: {
        content: "Марафон завершён, результат 3:58",
        sourceEntryRefs: ["entry_completion"],
      },
      status: "completed",
      title: "Марафон 2027",
    })]);

    expect(context.threads[0]).toMatchObject({
      completionEpisode: { content: "Марафон завершён, результат 3:58" },
      status: "completed",
    });
    expect(context.threads[0]).not.toHaveProperty("blocks.0");
  });
});
