/**
 * Session rotation policy tests.
 *
 * Constructs covered:
 * - `continuationTokenForGeneration`: generation-zero compatibility and isolated successors.
 * - `sessionNeedsRotation`: inactivity, turn-limit, manual, and pending-operation rules.
 */
import { describe, expect, it } from "vitest";

import {
  continuationTokenForGeneration,
  sessionNeedsRotation,
} from "./session-policy.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

describe("session rotation policy", () => {
  it("keeps the existing Eve continuation token for generation zero", () => {
    expect(continuationTokenForGeneration("101::", 0)).toBe("101::");
    expect(continuationTokenForGeneration("101::", 1)).toBe("101:::osinara:1");
  });

  it("rotates after inactivity or the completed-turn limit", () => {
    expect(sessionNeedsRotation({
      completedTurns: 1,
      lastActivityAt: new Date("2026-06-12T11:59:59.999Z"),
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: null,
    })).toBe(true);
    expect(sessionNeedsRotation({
      completedTurns: 250,
      lastActivityAt: NOW,
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: null,
    })).toBe(true);
  });

  it("defers every rotation reason while a HITL or OAuth operation is pending", () => {
    expect(sessionNeedsRotation({
      completedTurns: 250,
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      now: NOW,
      pendingOperation: true,
      rotationRequestedAt: NOW,
    })).toBe(false);
  });

  it("honours an explicit new-context request before automatic thresholds", () => {
    expect(sessionNeedsRotation({
      completedTurns: 2,
      lastActivityAt: NOW,
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: NOW,
    })).toBe(true);
  });
});
