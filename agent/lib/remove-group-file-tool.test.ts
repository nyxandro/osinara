/**
 * External group file removal contract tests.
 *
 * Constructs covered:
 * - Invalid relative paths fail before Eve requests destructive approval.
 * - A valid scope-relative path remains confirmation-gated.
 * - A group turn is refused outright, because its confirmation could never be shown.
 */
import { describe, expect, it } from "vitest";

import { removeGroupFileTool } from "./workspaces/remove-group-file-tool.js";

describe("remove_group_file approval", () => {
  it("rejects traversal before requesting approval", () => {
    expect(() => (removeGroupFileTool.approval as (context: never) => unknown)({
      toolInput: { path: "../family/private.md" },
    } as never)).toThrowError(/AGENT_WORKSPACE_PATH_INVALID/u);
  });

  it("refuses the deletion in a group turn instead of asking for an impossible confirmation", () => {
    const denial = (removeGroupFileTool.approval as (context: never) => unknown)({
      session: {
        auth: {
          current: {
            attributes: { groupId: "group-1", groupType: "external", telegramChatType: "supergroup" },
          },
        },
      },
      toolInput: { path: "reports/result.pdf" },
    } as never) as { reason: string; type: string };

    expect(denial.type).toBe("denied");
    expect(denial.reason).toContain("AGENT_APPROVAL_SURFACE_UNAVAILABLE");
  });

  it("requires approval for a valid group-relative path", () => {
    expect((removeGroupFileTool.approval as (context: never) => unknown)({
      session: { auth: { current: { attributes: { telegramChatType: "private" } } } },
      toolInput: { path: "reports/result.md" },
    } as never)).toBe("user-approval");
  });
});
