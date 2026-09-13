/** Exercise Eve 0.40's real lifecycle with the application's actual instruction resolver. */
import { describe, expect, it, vi } from "vitest";
import {
  buildDynamicInstructionMessages, dispatchDynamicInstructionEvent,
  drainDynamicInstructionUserMessages, prepareDynamicInstructionPreamble,
} from "../../../node_modules/eve/dist/src/context/dynamic-instruction-lifecycle.js";
import { SessionIdKey, AuthKey } from "../../../node_modules/eve/dist/src/context/keys.js";

const resolveMemory = vi.hoisted(() => vi.fn());
vi.mock("./turn-blocks.js", () => ({ resolveMemoryBlock: resolveMemory }));
import instructions from "../../instructions/retrieved-memory.js";

describe("native turn memory lifecycle", () => {
  it("keeps memory out of durable history, survives same-turn history compaction and replaces it on the next turn", async () => {
    const state = new Map<unknown, unknown>([[SessionIdKey, "session"], [AuthKey, {
      principalId: "owner", principalType: "user", authenticator: "telegram", attributes: {},
    }]]);
    const ctx = { get: (key: unknown) => state.get(key), set: (key: unknown, value: unknown) => state.set(key, value),
      setVirtualContext: (key: unknown, value: unknown) => state.set(key, value), delete: (key: unknown) => state.delete(key),
    } as never;
    const resolver = { ...instructions, slug: "retrieved-memory", eventNames: ["turn.started"] };
    const dispatch = async (turnId: string, messages: unknown[]) => {
      prepareDynamicInstructionPreamble(ctx, messages as never);
      await dispatchDynamicInstructionEvent({ ctx, resolvers: [resolver], messages,
        event: { type: "turn.started", data: { turnId }, meta: { id: turnId, at: "2026-09-13T07:00:00Z" } },
      } as never);
    };
    resolveMemory.mockResolvedValueOnce("authorized-first-turn-record");
    await dispatch("turn_0", [{ role: "user", content: "Собери дайджест" }]);
    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([]);
    const first = buildDynamicInstructionMessages(ctx);
    expect(first).toEqual([{ role: "system", content: expect.stringContaining("authorized-first-turn-record") }]);
    // A history clear/compaction cannot alter the separate system selection within this turn.
    prepareDynamicInstructionPreamble(ctx, []);
    expect(buildDynamicInstructionMessages(ctx)).toEqual(first);
    resolveMemory.mockResolvedValueOnce("AGENT_MEMORY_UNAVAILABLE");
    await dispatch("turn_1", [{ role: "user", content: "Другая задача после изменения доступа" }]);
    expect(JSON.stringify(buildDynamicInstructionMessages(ctx))).not.toContain("authorized-first-turn-record");
    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([]);
    resolveMemory.mockResolvedValueOnce(null);
    await dispatch("turn_2", []);
    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });
});
