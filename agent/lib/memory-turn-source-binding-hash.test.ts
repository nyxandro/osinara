import { describe, expect, it } from "vitest";

import { reviewSourceBindingHash, turnSourceBindingHash } from "./memory-turn-source-binding-hash.js";

const SESSION = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";

// The expected values are hashes already stored in `memory_turn_source_sets.binding_hash`: a turn
// bound before an update and resumed after it must produce the same value, or its replay fails.
describe("memory turn source binding hashes", () => {
  it("keeps the stored hash of a conversation turn binding", () => {
    expect(turnSourceBindingHash({
      applicationSessionId: "app-1",
      conversationId: "conv-1",
      currentTimelineEntryId: "entry-2",
      agentSessionId: SESSION,
      agentTurnId: "turn-1",
      invokingActorId: "actor-1",
      invokingActorKind: "telegram_user",
    }, ["entry-1", "entry-2"])).toBe("e7aad060a7c946d56145d9847d0c0d70e4eaaa3563a29f542a796bb10a9f3824");
  });

  it("keeps the stored hash of a memory review binding regardless of the caller's field order", () => {
    expect(reviewSourceBindingHash({
      memoryReviewBatchId: "batch-1",
      invokingActorKind: "telegram_user",
      invokingActorId: "actor-1",
      agentTurnId: "turn-1",
      agentSessionId: SESSION,
      conversationId: "conv-1",
      applicationSessionId: "app-1",
    }, ["entry-1", "entry-2"])).toBe("afb8e2c39311054eb1d0496a41b4910f07b5bf7091344fb077aa009a60b61c94");
  });
});
