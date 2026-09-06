/**
 * Memory retention score tests.
 *
 * Constructs covered:
 * - Base stability by record kind, including the discussion-summary slot.
 * - Age counts from the last reinforcement, else the event date, else creation.
 * - Reinforcement widens stability logarithmically.
 * - The rank floor keeps a faded record searchable.
 */
import { describe, expect, it } from "vitest";

import {
  isRetainedForAutomaticContext,
  memoryRetention,
  memoryStabilityDays,
  retentionRankFactor,
} from "./memory-retention-score.js";

const now = new Date("2026-09-05T12:00:00Z");
const daysAgo = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

describe("memoryRetention", () => {
  it("uses the kind stability: episode 30, discussion summary 60, semantic 180", () => {
    expect(memoryStabilityDays("episode", null)).toBe(30);
    expect(memoryStabilityDays("episode", "итог обсуждения")).toBe(60);
    expect(memoryStabilityDays("profile", "город")).toBe(180);
    expect(memoryStabilityDays("family_shared", null)).toBe(180);
  });

  it("decays from the last reinforcement, else the event date, else creation", () => {
    const base = { attribute: null, kind: "episode" as const, reinforcementCount: 0 };
    expect(memoryRetention({ ...base, createdAt: now, lastReinforcedAt: null, occurredAt: null }, now))
      .toBeCloseTo(1, 5);
    expect(memoryRetention({ ...base, createdAt: daysAgo(30), lastReinforcedAt: null, occurredAt: null }, now))
      .toBeCloseTo(Math.exp(-1), 5);
    expect(memoryRetention({ ...base, createdAt: now, lastReinforcedAt: null, occurredAt: daysAgo(30) }, now))
      .toBeCloseTo(Math.exp(-1), 5);
    expect(memoryRetention({
      ...base, createdAt: daysAgo(90), lastReinforcedAt: daysAgo(30), occurredAt: daysAgo(90),
    }, now)).toBeCloseTo(Math.exp(-1), 5);
  });

  it("grows stability with reinforcement: S = S0 * (1 + ln(1 + n))", () => {
    const input = {
      attribute: null, createdAt: daysAgo(30), kind: "episode" as const, lastReinforcedAt: null, occurredAt: null,
    };
    const once = memoryRetention({ ...input, reinforcementCount: 1 }, now);
    expect(once).toBeCloseTo(Math.exp(-30 / (30 * (1 + Math.log(2)))), 5);
    expect(once).toBeGreaterThan(memoryRetention({ ...input, reinforcementCount: 0 }, now));
  });

  it("keeps an old but relevant record findable through the rank floor", () => {
    expect(retentionRankFactor(1)).toBeCloseTo(1, 5);
    expect(retentionRankFactor(0)).toBeCloseTo(0.3, 5);
    expect(retentionRankFactor(0.5)).toBeCloseTo(0.65, 5);
  });

  it("admits a record into the automatic block only above the minimum retention", () => {
    expect(isRetainedForAutomaticContext(0.2)).toBe(true);
    expect(isRetainedForAutomaticContext(0.19)).toBe(false);
  });
});
