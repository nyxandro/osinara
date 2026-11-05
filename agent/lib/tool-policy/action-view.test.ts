/**
 * One tool with several actions, shown in a place with only some of them.
 *
 * Constructs covered:
 * - The view keeps the tool's name contract but describes and accepts only its own actions.
 * - An action outside the view is refused before the tool, its approval or a right check runs.
 * - A right is checked for the requested action before the tool runs.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { normalizeModelFacingError } from "../model-facing-error.js";
import { actionView } from "./action-view.js";

const context = { callId: "call-1" } as unknown as ToolContext;

function sampleTool() {
  const execute = vi.fn(async (input: { action: string }) => ({ done: input.action }));
  const approval = vi.fn(() => "user-approval" as const);
  const definition = defineTool({
    approval,
    description: "full description",
    execute,
    inputSchema: z.object({ action: z.enum(["list", "delete"]), id: z.string().optional() }).strict(),
    replaySafe: true,
  });
  return { approval, definition, execute };
}

const LIST_ONLY = {
  description: "list only",
  inputSchema: z.object({ action: z.enum(["list"]) }).strict(),
};

describe("actionView", () => {
  it("describes only its own actions and keeps the tool's replay contract", () => {
    const { definition } = sampleTool();
    const view = actionView({ actions: ["list"], definition, presentation: LIST_ONLY, toolName: "sample" });

    expect(view.description).toBe("list only");
    expect(view.inputSchema).toBe(LIST_ONLY.inputSchema);
    expect(view.replaySafe).toBe(true);
  });

  it("runs an action of the view", async () => {
    const { definition, execute } = sampleTool();
    const view = actionView({ actions: ["list"], definition, presentation: LIST_ONLY, toolName: "sample" });

    await expect(view.execute({ action: "list" }, context)).resolves.toEqual({ done: "list" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses an action outside the view before the tool runs", async () => {
    const { definition, execute } = sampleTool();
    const view = actionView({ actions: ["list"], definition, presentation: LIST_ONLY, toolName: "sample" });

    const refusal = await view.execute({ action: "delete", id: "x" }, context).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "AGENT_TOOL_ACTION_FORBIDDEN" });
    expect(execute).not.toHaveBeenCalled();
    // The model hears an expected refusal of this place, not a failure of unknown outcome.
    const normalized = normalizeModelFacingError(refusal as Error, { toolName: "sample" });
    expect(normalized.contract).toMatchObject({ category: "authorization", sideEffectStatus: "not_started" });
    expect(normalized.isExpectedRefusal).toBe(true);
  });

  it("asks for no approval of an action the view refuses anyway", async () => {
    const { approval, definition } = sampleTool();
    const view = actionView({ actions: ["list"], definition, presentation: LIST_ONLY, toolName: "sample" });

    await expect(view.approval?.({ toolInput: { action: "delete" } } as never)).resolves.toBe("not-applicable");
    expect(approval).not.toHaveBeenCalled();
    await expect(view.approval?.({ toolInput: { action: "list" } } as never)).resolves.toBe("user-approval");
  });

  it("checks the right of the requested action before the tool runs", async () => {
    const { definition, execute } = sampleTool();
    const authorize = vi.fn(async () => {
      throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
    const view = actionView({
      actions: ["list"], authorize, definition, presentation: LIST_ONLY, toolName: "sample",
    });

    await expect(view.execute({ action: "list" }, context)).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
    expect(authorize).toHaveBeenCalledWith(context, "list");
    expect(execute).not.toHaveBeenCalled();
  });
});
