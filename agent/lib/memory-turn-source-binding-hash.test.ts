import { describe, expect, it } from "vitest";

import { reviewSourceBindingHash, turnSourceBindingHash } from "./memory-turn-source-binding-hash.js";

const SESSION = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";

// The expected values pin the stored format of `memory_turn_source_sets.binding_hash`: a turn bound
// by one release and started again after a crash by the next must produce the same value.
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
    }, ["entry-1", "entry-2"])).toBe("9aaeb922bac093c691931b422d1476f51b61268b5b94ddc49730449c1cafd742");
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
    }, ["entry-1", "entry-2"])).toBe("206b9a1b941a43ea4d43f19546b697db4743af5106788d1e11b62918f56a118e");
  });
});
