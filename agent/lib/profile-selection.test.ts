/**
 * Deterministic R3 profile selection tests.
 *
 * Constructs covered:
 * - `selectProfileClaims`: subject, per-subject, and total whole-claim budgets.
 * - Sensitive, episode, inactive, and dormant candidates never enter always-on profile context.
 * - Priority and output remain deterministic regardless of PostgreSQL input order.
 */
import { describe, expect, it } from "vitest";

import {
  PROFILE_CONTEXT_MAX_CHARACTERS,
  PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT,
  PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS,
  PROFILE_CONTEXT_MAX_SUBJECTS,
} from "./memory-config.js";
import {
  selectProfileClaims,
  type ProfileClaimCandidate,
} from "./profile-selection.js";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function candidate(input: Partial<ProfileClaimCandidate> & {
  memoryRef: string;
  subjectRef: string;
}): ProfileClaimCandidate {
  return {
    attribute: null,
    claimStatus: "active",
    confirmation: "model_high",
    content: `claim-${input.memoryRef}`,
    evidenceKind: "firsthand",
    kind: "fact",
    lastVerifiedAt: "2026-08-08T11:00:00.000Z",
    originLabel: "Семейный чат",
    originScope: "family",
    observedAt: "2026-08-08T10:00:00.000Z",
    priority: "retrieval_related",
    profileEligible: true,
    sensitivity: "normal",
    sourceAuthorLabel: "Анна",
    subjectLabel: input.subjectRef,
    updatedAt: "2026-08-08T11:00:00.000Z",
    ...input,
  };
}

describe("R3 profile selection", () => {
  it("selects no more than four prioritized subjects without injecting all participants", () => {
    const priorities = [
      "retrieval_related",
      "explicit_mention",
      "reply_subject",
      "current_author",
      "retrieval_related",
    ] as const;
    const candidates = priorities.map((priority, index) => candidate({
      memoryRef: `mem_${String(index).padStart(32, "0")}`,
      priority,
      subjectRef: `subj_${String(index).padStart(32, "0")}`,
    }));

    const selected = selectProfileClaims(candidates, NOW);

    expect(selected.subjects).toHaveLength(PROFILE_CONTEXT_MAX_SUBJECTS);
    expect(selected.subjects.map((subject) => subject.priority)).toEqual([
      "current_author",
      "reply_subject",
      "explicit_mention",
      "retrieval_related",
    ]);
  });

  it("keeps only whole eligible claims within all character and count budgets", () => {
    const oversized = "я".repeat(PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS + 1);
    const candidates = Array.from(
      { length: PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT + 5 },
      (_, index) => candidate({
        content: index === 0 ? oversized : `Устойчивая запись ${index} ${"я".repeat(300)}`,
        memoryRef: `mem_${String(index).padStart(32, "0")}`,
        priority: "current_author",
        subjectRef: "subj_00000000000000000000000000000001",
      }),
    );
    candidates.push(
      candidate({
        memoryRef: "mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sensitivity: "sensitive",
        subjectRef: "subj_00000000000000000000000000000001",
      }),
      candidate({
        kind: "episode",
        memoryRef: "mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        subjectRef: "subj_00000000000000000000000000000001",
      }),
      candidate({
        claimStatus: "superseded",
        memoryRef: "mem_cccccccccccccccccccccccccccccccc",
        subjectRef: "subj_00000000000000000000000000000001",
      }),
    );

    const selected = selectProfileClaims(candidates, NOW);
    const claims = selected.subjects[0]!.claims;

    expect(claims.length).toBeLessThanOrEqual(PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT);
    expect(selected.totalCharacters).toBeLessThanOrEqual(PROFILE_CONTEXT_MAX_CHARACTERS);
    expect(selected.subjects[0]!.totalCharacters)
      .toBeLessThanOrEqual(PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS);
    expect(claims.some((claim) => claim.content === oversized)).toBe(false);
    expect(claims.every((claim) => claim.sensitivity === "normal" && claim.kind !== "episode"))
      .toBe(true);
  });

  it("marks a subject dormant after 60 days and reactivates it on a verified message", () => {
    const dormant = candidate({
      lastVerifiedAt: "2026-06-01T00:00:00.000Z",
      memoryRef: "mem_dddddddddddddddddddddddddddddddd",
      subjectRef: "subj_dddddddddddddddddddddddddddddddd",
    });
    const reactivated = { ...dormant, lastVerifiedAt: NOW.toISOString() };

    expect(selectProfileClaims([dormant], NOW).subjects).toEqual([]);
    expect(selectProfileClaims([reactivated], NOW).subjects).toHaveLength(1);
  });

  it("produces identical ordered metadata for every input order", () => {
    const candidates = [
      candidate({
        confirmation: "user_confirmed",
        memoryRef: "mem_11111111111111111111111111111111",
        priority: "current_author",
        subjectRef: "subj_11111111111111111111111111111111",
      }),
      candidate({
        memoryRef: "mem_22222222222222222222222222222222",
        priority: "current_author",
        subjectRef: "subj_11111111111111111111111111111111",
        updatedAt: "2026-08-08T11:30:00.000Z",
      }),
      candidate({
        memoryRef: "mem_33333333333333333333333333333333",
        priority: "reply_subject",
        subjectRef: "subj_33333333333333333333333333333333",
      }),
    ];

    expect(selectProfileClaims(candidates, NOW))
      .toEqual(selectProfileClaims([...candidates].reverse(), NOW));
  });

  it("puts attribute slots first and renders the slot name", () => {
    const selection = selectProfileClaims([
      candidate({ content: "Любит кофе", kind: "preference", memoryRef: "mem_2", subjectRef: "subj_1" }),
      candidate({ attribute: "работа", content: "Логист", kind: "profile", memoryRef: "mem_1", subjectRef: "subj_1" }),
      candidate({ content: "Родился в Туле", kind: "profile", memoryRef: "mem_3", subjectRef: "subj_1" }),
    ], NOW);

    const claims = selection.subjects[0]!.claims;
    expect(claims.map((claim) => claim.memoryRef)).toEqual(["mem_1", "mem_3", "mem_2"]);
    expect(claims[0]!.renderedText).toContain("работа: Логист");
  });
});
