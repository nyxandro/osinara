/**
 * Memory-review model boundary tests.
 *
 * Constructs covered:
 * - Internal review turns expose memory reads and `remember`, but override every unrelated built-in.
 * - Review instructions require all 50 sources, forbid sensitive writes, and suppress chat output.
 * - Live authorization failures use the common structured model-facing error contract.
 * - Review `remember` offers only subjects that need no profile view.
 */
import type { SessionAuth } from "eve/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability,
}));

import {
  MEMORY_REVIEW_DENIED_TOOL_NAMES,
  buildMemoryReviewToolSurface,
} from "./memory-review-tool-surface.js";
import { memoryReviewInstructions } from "./memory-review-prompt.js";
import { rememberInputSchema } from "../remember-contract.js";
import { memoryReviewScope } from "./memory-review-session.js";
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

describe("memory review model surface", () => {
  beforeEach(() => {
    authorizeCurrentExternalGroupCapability.mockReset();
  });

  it("contains only memory capabilities plus explicit framework denials", () => {
    const names = Object.keys(buildMemoryReviewToolSurface("family")).sort();

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
    const names = Object.keys(buildMemoryReviewToolSurface("family", new Set(["list_memories"]))).sort();

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
    const surface = buildMemoryReviewToolSurface("family", new Set([toolName]));
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
    const instructions = memoryReviewInstructions("family");
    expect(instructions).toContain("не более 50");
    expect(instructions).toContain("<memory_review_source_selection>");
    expect(instructions).toContain("sourceSequence");
    expect(instructions).toContain("Не отправляй ответ в Telegram");
    expect(instructions).toContain("sensitivity: normal");
    expect(instructions).not.toMatch(/[—–«»]/u);
  });

  it("names the one memory scope this review turn is allowed to write into", () => {
    // The background run carries exactly one authorized scope, and the tool description shows
    // `personal` in its example: without this line the model picks a scope the backend refuses.
    expect(memoryReviewInstructions("family")).toContain('scope "family"');
    expect(memoryReviewInstructions("group")).toContain('scope "group"');
    expect(memoryReviewInstructions("group")).not.toMatch(/[—–«»]/u);
  });

  it("gives the review run a remember that accepts only its own scope", () => {
    const surface = buildMemoryReviewToolSurface("family");
    const schema = (surface.remember as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    }).inputSchema;
    const payload = {
      basis: "agent_inferred", content: "Мама работает в школе", kind: "fact",
      sensitivity: "normal", sourceSequence: "42", subject: { kind: "current_author" },
    };

    expect(schema.safeParse({ ...payload, scope: "family" }).success).toBe(true);
    // Three parallel calls into a forbidden scope are then impossible, not merely discouraged.
    expect(schema.safeParse({ ...payload, scope: "personal" }).success).toBe(false);
    expect(schema.safeParse({ ...payload, scope: "group" }).success).toBe(false);
  });

  it("offers the review run only subjects it can resolve without a profile view", () => {
    // A background run never has profile views, so a verified_ref there is refused every time (#289).
    const schema = (buildMemoryReviewToolSurface("group").remember as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    }).inputSchema;
    const payload = {
      basis: "agent_inferred", content: "Любит походы", kind: "preference", scope: "group",
      sensitivity: "normal", sourceSequence: "42",
    };
    const verifiedRef = { kind: "verified_ref", subjectRef: `subj_${"a".repeat(32)}` };

    for (const subject of [{ kind: "current_author" }, { kind: "label", label: "Оля" }, { kind: "none" }]) {
      expect(schema.safeParse({ ...payload, subject }).success).toBe(true);
    }
    expect(schema.safeParse({ ...payload, subject: verifiedRef }).success).toBe(false);
    // Some providers serialize the nested subject into a string; that path must refuse it too.
    expect(schema.safeParse({ ...payload, subject: JSON.stringify(verifiedRef) }).success).toBe(false);
    expect(schema.safeParse({ ...payload, subject: JSON.stringify({ kind: "current_author" }) }).success)
      .toBe(true);
    // Conversation turns do issue profile views and keep the verified reference.
    expect(rememberInputSchema.safeParse({ ...payload, subject: verifiedRef }).success).toBe(true);
    // Nothing the model reads, including the serialized-string pattern, may still offer it.
    expect(JSON.stringify(z.toJSONSchema(schema as never, { io: "input" }))).not.toContain("verified_ref");
    expect(JSON.stringify(z.toJSONSchema(rememberInputSchema, { io: "input" }))).toContain("verified_ref");
  });

  it("refuses to guess the review scope when the run does not carry exactly one", () => {
    const withScopes = (memoryScopes: unknown) => ({
      session: { auth: { current: { attributes: { memoryScopes } } } },
    }) as never;

    expect(memoryReviewScope(withScopes(["group"]))).toBe("group");
    expect(() => memoryReviewScope(withScopes(["family", "personal"]))).toThrowError(
      /AGENT_MEMORY_REVIEW_CONTEXT_INVALID/u,
    );
    expect(() => memoryReviewScope(withScopes(undefined))).toThrowError(
      /AGENT_MEMORY_REVIEW_CONTEXT_INVALID/u,
    );
  });

  it("resolves only an exact internal review continuation", () => {
    const batchId = "00000000-0000-4000-8000-000000000050";
    expect(memoryReviewBatchIdFromContinuationToken(`memory-review:${batchId}`)).toBe(batchId);
    expect(memoryReviewBatchIdFromContinuationToken(`telegram:${batchId}`)).toBeNull();
  });
});
