/**
 * The retrieved-memory block belongs to one turn: it is resolved per turn and never enters history.
 * The profile card of the same turn is the exception: it is a user-role block written into history.
 */
import { describe, expect, it, vi } from "vitest";

const resolveMemory = vi.hoisted(() => vi.fn());
vi.mock("./turn-blocks.js", () => ({ resolveMemoryBlock: resolveMemory }));

import { retrievedMemoryInstructions } from "../../instructions/retrieved-memory.js";
import { resolveTurnInstructions } from "../../runtime/prompt/turn-instructions.js";

function turn(turnId: string, message: string) {
  return {
    channel: { kind: "telegram" },
    messages: [{ role: "user" as const, content: message }],
    session: { auth: { current: null, initiator: null }, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR" },
    turnId,
  };
}

describe("turn memory block", () => {
  it("is a system block of its own turn only, bound to that turn's id", async () => {
    resolveMemory.mockResolvedValueOnce({ memory: "authorized-first-turn-record", profileCard: null });
    const first = await resolveTurnInstructions([retrievedMemoryInstructions], turn("turn_A", "Собери дайджест"));

    expect(first).toEqual({ system: ["authorized-first-turn-record"], user: [] });
    expect(resolveMemory).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [{ role: "user", content: "Собери дайджест" }] }), "turn_A");

    resolveMemory.mockResolvedValueOnce({ memory: "AGENT_MEMORY_UNAVAILABLE", profileCard: null });
    const second = await resolveTurnInstructions([retrievedMemoryInstructions], turn("turn_B", "Другая задача после изменения доступа"));
    expect(JSON.stringify(second)).not.toContain("authorized-first-turn-record");

    resolveMemory.mockResolvedValueOnce({ memory: null, profileCard: null });
    expect(await resolveTurnInstructions([retrievedMemoryInstructions], turn("turn_C", "Ещё"))).toEqual({ system: [], user: [] });
  });

  it("hands the profile card to history as a user-role block next to the turn's own block", async () => {
    resolveMemory.mockResolvedValueOnce({ memory: "people-of-this-turn", profileCard: "<profile_card/>" });

    expect(await resolveTurnInstructions([retrievedMemoryInstructions], turn("turn_D", "Что мне заказать?"))).toEqual({
      system: ["people-of-this-turn"],
      user: [{ role: "user", content: "<profile_card/>" }],
    });
  });
});
