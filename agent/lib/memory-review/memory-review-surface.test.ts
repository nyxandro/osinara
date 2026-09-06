/**
 * Memory-review model boundary tests.
 *
 * Constructs covered:
 * - Internal review turns expose memory reads and `remember`, but override every unrelated built-in.
 * - Review instructions require all 50 sources, forbid sensitive writes, and suppress chat output.
 * - Live authorization failures use the common structured model-facing error contract.
 */
import type { SessionAuth } from "eve/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability,
}));

import {
  MEMORY_REVIEW_DENIED_TOOL_NAMES,
  buildMemoryReviewToolSurface,
} from "./memory-review-tool-surface.js";
import { MEMORY_REVIEW_INSTRUCTIONS, formatExistingMemoryForReview } from "./memory-review-prompt.js";
import { memoryReviewBatchIdFromContinuationToken } from "./memory-review-session.js";

function externalAuth(): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        toolAllowlist: [
          "list_memories",
          "list_memory_threads",
          "read_memory_thread",
          "remember",
          "search_memories",
          "search_memory_threads",
        ],
      },
      authenticator: "memory-review",
      principalId: "owner-1",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("memory review existing memory block", () => {
  it("renders existing memory for review as untrusted data with refs and slots", () => {
    const block = formatExistingMemoryForReview([
      { attribute: "работа", content: "Serje пишет книгу", kind: "profile", memoryRef: "mem_1", subjectLabel: "Serje" },
    ]);
    expect(block).toContain("<existing_memory>");
    expect(block).toContain("mem_1");
    expect(block).toContain("работа");
    expect(formatExistingMemoryForReview([])).toBe("");
  });
});

describe("memory review instructions", () => {
  it("selects by future usefulness and folds a discussion into one record", () => {
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("изменит будущий ответ");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("одна запись episode");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("итог обсуждения");
    expect(MEMORY_REVIEW_INSTRUCTIONS).not.toContain("всё, что пригодится");
    expect(MEMORY_REVIEW_INSTRUCTIONS).not.toContain("от 3 до 10 записей");
  });

  it("describes silent review for any conversation and the personal scope choice", () => {
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("тихая проверка памяти разговора");
    expect(MEMORY_REVIEW_INSTRUCTIONS).not.toContain("памяти группы");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("scope personal");
  });
});

describe("memory review model surface", () => {
  beforeEach(() => {
    authorizeCurrentExternalGroupCapability.mockReset();
  });

  it("contains only memory capabilities plus explicit framework denials", () => {
    const names = Object.keys(buildMemoryReviewToolSurface()).sort();

    expect(names).toEqual([
      ...MEMORY_REVIEW_DENIED_TOOL_NAMES,
      "list_memories",
      "list_memory_threads",
      "read_memory_thread",
      "remember",
      "search_memories",
      "search_memory_threads",
    ].sort());
    expect(names).not.toContain("manage_memory");
    expect(names).not.toContain("manage_memory_thread");
  });

  it("omits external memory descriptors that are not currently granted", () => {
    const names = Object.keys(buildMemoryReviewToolSurface(new Set(["list_memories"]))).sort();

    expect(names).toContain("list_memories");
    expect(names).not.toContain("remember");
    expect(names).not.toContain("search_memories");
  });

  it.each([
    "list_memories",
    "list_memory_threads",
    "read_memory_thread",
    "search_memories",
    "search_memory_threads",
  ] as const)("re-checks live external authorization before executing %s", async (toolName) => {
    const surface = buildMemoryReviewToolSurface(new Set([toolName]));
    authorizeCurrentExternalGroupCapability.mockRejectedValueOnce(
      new Error("AGENT_GROUP_TOOL_FORBIDDEN"),
    );

    await expect(surface[toolName]!.execute({}, {
      session: { auth: externalAuth() },
    } as never)).rejects.toMatchObject({
      contract: {
        category: "authorization",
        code: "AGENT_GROUP_TOOL_FORBIDDEN",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
    expect(authorizeCurrentExternalGroupCapability).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    }, toolName);
  });

  it("states the exact silent and source-backed review contract", () => {
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("не более 50");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("<memory_review_source_selection>");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("sourceSequence");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("Не отправляй ответ в Telegram");
    expect(MEMORY_REVIEW_INSTRUCTIONS).toContain("sensitivity: normal");
    expect(MEMORY_REVIEW_INSTRUCTIONS).not.toMatch(/[—–«»]/u);
  });

  it("resolves only an exact internal review continuation", () => {
    const batchId = "00000000-0000-4000-8000-000000000050";
    expect(memoryReviewBatchIdFromContinuationToken(`memory-review:${batchId}`)).toBe(batchId);
    expect(memoryReviewBatchIdFromContinuationToken(`telegram:${batchId}`)).toBeNull();
  });
});
