/** Exercise the installed Eve lifecycle, not a direct call to an application-only session method. */
import { describe, expect, it, vi } from "vitest";
import { defineSkill } from "../runtime/skills/definition.js";
import { ContextContainer } from "../../node_modules/eve/dist/src/context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "../../node_modules/eve/dist/src/context/keys.js";
import { dispatchDynamicSkillEvent } from "../../node_modules/eve/dist/src/context/dynamic-skill-lifecycle.js";

describe("Eve bulk skill materialization", () => {
  it("uses one complete backend batch and removes revoked names through the same lifecycle", async () => {
    const syncSkillPackages = vi.fn(async () => {}), writeBinaryFile = vi.fn(), removePath = vi.fn();
    const sandbox = { syncSkillPackages, writeBinaryFile, removePath, run: vi.fn(async () => ({ exitCode: 0, stdout: "/tools/group/home\n", stderr: "" })) };
    const ctx = new ContextContainer(); ctx.set(SandboxKey, { get: async () => sandbox } as never);
    const resolver = vi.fn<() => unknown>(() => ({ test: defineSkill({ description: "Reviewed package", markdown: "# Reviewed", files: { "support.txt": "extra" } }) }));
    const dispatch = () => dispatchDynamicSkillEvent({ ctx, messages: [], event: { type: "turn.started", data: { turnId: "turn_1", sequence: 1 } },
      resolvers: [{ slug: "scoped", eventNames: ["turn.started"], events: { "turn.started": resolver } }],
    } as never);
    await dispatch();
    expect(syncSkillPackages).toHaveBeenCalledWith([expect.objectContaining({ name: "test", files: [
      { relativePath: "SKILL.md", content: Buffer.from("# Reviewed") }, { relativePath: "support.txt", content: Buffer.from("extra") },
    ] })], []);
    expect(writeBinaryFile).not.toHaveBeenCalled(); expect(removePath).not.toHaveBeenCalled();
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({ scoped: [{ name: "test", description: "Reviewed package" }] });
    resolver.mockReturnValue(null); await dispatch();
    expect(syncSkillPackages).toHaveBeenLastCalledWith([], ["test"]);
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
  });
});
