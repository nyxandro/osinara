/**
 * External Telegram group tool policy tests.
 *
 * Constructs covered:
 * - `resolveExternalGroupToolPolicy`: derives policy only from verified Eve auth attributes.
 * - `createExternalGroupToolOverrides`: blocks controlled tools but leaves isolated file tools native.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it } from "vitest";

import {
  createExternalGroupToolOverrides,
  resolveExternalGroupToolPolicy,
} from "./group-tool-policy.js";

function externalAuth(toolAllowlist: readonly string[], role = "external"): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external_private",
        role,
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "telegram:101",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("external group tool policy", () => {
  it("does not restrict a non-external session", () => {
    expect(resolveExternalGroupToolPolicy({ current: null, initiator: null })).toEqual({
      restricted: false,
    });
  });

  it("uses the current external policy and accepts an explicit empty deny-all list", () => {
    expect(resolveExternalGroupToolPolicy(externalAuth([]))).toEqual({
      allowed: new Set(),
      restricted: true,
    });
    expect(resolveExternalGroupToolPolicy(externalAuth(["remember"]))).toEqual({
      allowed: new Set(["remember"]),
      restricted: true,
    });
  });

  it("fails closed when an external auth snapshot contains an invalid policy", () => {
    const auth = externalAuth(["unknown_tool"]);

    expect(resolveExternalGroupToolPolicy(auth)).toEqual({
      allowed: new Set(),
      restricted: true,
    });
  });

  it("retains the verified external initiator policy when HITL resumes without current auth", () => {
    const initial = externalAuth(["manage_memory.delete"]);

    expect(
      resolveExternalGroupToolPolicy({ current: null, initiator: initial.current }),
    ).toEqual({
      allowed: new Set(["manage_memory.delete"]),
      restricted: true,
    });
  });

  it("keeps a family owner restricted by the external group allowlist", () => {
    const ownerInExternalGroup = externalAuth(["remember"], "owner");

    expect(resolveExternalGroupToolPolicy(ownerInExternalGroup)).toEqual({
      allowed: new Set(["remember"]),
      restricted: true,
    });
  });

  it("overrides unlisted authored and framework tools with stable denials", async () => {
    const overrides = createExternalGroupToolOverrides(new Set(["remember"]));

    expect(Object.keys(overrides)).toEqual(
      expect.arrayContaining(["remember", "manage_reminder", "bash", "web_fetch"]),
    );
    await expect(
      overrides.manage_reminder!.execute({}, {} as never),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    await expect(overrides.bash!.execute({}, {} as never)).rejects.toThrowError(
      /AGENT_GROUP_TOOL_FORBIDDEN/,
    );
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const overrides = createExternalGroupToolOverrides(new Set(["manage_memory.undo"]));
    const context = { session: { auth: externalAuth(["manage_memory.undo"]) } } as never;

    await expect(
      overrides.manage_memory!.execute(
        { action: "delete", id: "00000000-0000-4000-8000-000000000001" },
        context,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(createExternalGroupToolOverrides(new Set())).not.toHaveProperty("remove_group_file");
    expect(
      createExternalGroupToolOverrides(new Set(["remove_group_file"])),
    ).toHaveProperty("remove_group_file");
  });

  it("keeps native filesystem tools available in every isolated group workspace", () => {
    const overrides = createExternalGroupToolOverrides(new Set());

    expect(overrides).not.toHaveProperty("glob");
    expect(overrides).not.toHaveProperty("grep");
    expect(overrides).not.toHaveProperty("read_file");
    expect(overrides).not.toHaveProperty("write_file");
    expect(overrides).toHaveProperty("bash");
  });
});
