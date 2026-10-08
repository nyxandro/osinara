/**
 * The automatic memory selection of a turn.
 *
 * Constructs covered:
 * - A question that names a day gets that day's records first, those the search found too ahead.
 * - «Вчера» is read on the person's own calendar, on the group's in a group.
 * - A question that names no day reads no settings and no period.
 * - Small talk runs no search at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { currentTimeRepository } from "./current-time-repository.js";
import { selectMemoriesAutomatically } from "./memory-automatic-selection.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryEventWindowRepository } from "./memory-event-window-repository.js";
import type { ReferencedMemoryItem } from "./memory-record.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { GROUP_REMINDER_TIMEZONE } from "./reminders/reminder-config.js";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryQueryChunks: vi.fn(async () => [Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.1)]),
}));

const privateAuth: MemoryAuthorization = {
  familyId: "family-1", groupId: null, role: "owner", scopes: ["personal", "family"],
  telegramActorId: "actor-1", telegramActorKind: "telegram_user", telegramUserId: "actor-1", userId: "user-1",
};

function item(id: string): ReferencedMemoryItem {
  return {
    attribute: null, author: { status: "current_member", telegramUserId: "actor-1", userId: "user-1" },
    confirmation: "user_confirmed", content: `запись ${id}`, createdAt: "2026-10-01T10:00:00.000Z",
    embeddingStatus: "indexed", id, kind: "episode", memoryRef: `mem_${id}`, messageThreadId: null,
    occurredOn: null, scope: "personal", sensitivity: "normal", source: "test", updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

function searchFinds(...ids: string[]) {
  return vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure").mockResolvedValue({
    claimIdsByConflictRef: new Map(),
    conflicts: [],
    diagnostics: {
      candidateLimitHit: false, recentlyShown: 0, russianMatched: 1, russianQualified: 1, russianTopRank: 0.1,
      semanticMatched: 40, semanticQualified: 12, semanticTopSimilarity: 0.84,
      simpleMatched: 0, simpleQualified: 0, simpleTopRank: null,
    },
    relatedClaimIds: ids,
    results: ids.map((id, index) => ({
      evidence: { russianMorphologyRank: 0.1, semanticSimilarity: 0.84, simpleLexicalRank: null },
      exactDuplicateIdentity: id, memory: item(id), score: 0.03 - index * 0.001, subjectLabel: null,
    })),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("selectMemoriesAutomatically", () => {
  it("puts the day a question names first, the records found by topic too ahead of the rest", async () => {
    searchFinds("topic-only", "topic-and-day");
    const window = vi.spyOn(memoryEventWindowRepository, "search")
      .mockResolvedValue([item("day-newest"), item("topic-and-day"), item("day-older")]);
    vi.spyOn(currentTimeRepository, "findUserTimezone").mockResolvedValue("Europe/Moscow");

    // 22:30 UTC on the 7th is already the 8th in Moscow, so «вчера» is the 7th there.
    const selection = await selectMemoriesAutomatically(privateAuth, "что было вчера с ремонтом?", {
      now: new Date("2026-10-07T22:30:00.000Z"), window: null,
    });

    expect(window).toHaveBeenCalledWith(privateAuth, { from: "2026-10-07", timezone: "Europe/Moscow", to: "2026-10-07" });
    expect(selection.selected.map((selected) => selected.memory.id))
      .toEqual(["topic-and-day", "day-newest", "day-older", "topic-only"]);
    expect(selection.selected[1]!.score).toBeNull();
    expect(selection.dateWindow).toEqual({ form: "yesterday", from: "2026-10-07", records: 3, to: "2026-10-07" });
    expect(selection.relatedClaimIds).toEqual(["topic-and-day", "day-newest", "day-older", "topic-only"]);
  });

  it("reads a group's day on the group's calendar", async () => {
    searchFinds();
    const window = vi.spyOn(memoryEventWindowRepository, "search").mockResolvedValue([]);
    const settings = vi.spyOn(currentTimeRepository, "findUserTimezone");

    await selectMemoriesAutomatically({ ...privateAuth, groupId: "group-1", scopes: ["group"], userId: null },
      "что вчера в чатике было интересного?", { now: new Date("2026-10-07T22:30:00.000Z"), window: null });

    expect(settings).not.toHaveBeenCalled();
    expect(window).toHaveBeenCalledWith(expect.anything(), {
      from: "2026-10-07", timezone: GROUP_REMINDER_TIMEZONE, to: "2026-10-07",
    });
  });

  it("reads no settings and no period for a question that names no day", async () => {
    searchFinds("topic-only");
    const window = vi.spyOn(memoryEventWindowRepository, "search");
    const settings = vi.spyOn(currentTimeRepository, "findUserTimezone");

    const selection = await selectMemoriesAutomatically(privateAuth, "где лежат ключи от гаража?", {
      now: new Date("2026-10-08T10:00:00.000Z"), window: null,
    });

    expect(window).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(selection.dateWindow).toBeNull();
    expect(selection.selected.map((selected) => selected.memory.id)).toEqual(["topic-only"]);
  });

  it("runs no search for small talk", async () => {
    const search = vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure");

    const selection = await selectMemoriesAutomatically(privateAuth, "спасибо, понял", {
      now: new Date(), window: null,
    });

    expect(search).not.toHaveBeenCalled();
    expect(selection).toMatchObject({ abstained: true, embeddings: [], selected: [] });
  });
});
