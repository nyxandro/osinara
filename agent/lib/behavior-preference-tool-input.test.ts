/**
 * User-managed chat instruction tool contract tests.
 *
 * Constructs covered:
 * - get, append, replace, and clear operate without model-selected identity or categories.
 * - Mutations use the visible prompt revision to prevent lost concurrent edits.
 * - Prompt text is bounded but receives no semantic classification in backend code.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const dependencies = vi.hoisted(() => ({
  authorization: {
    conversationId: "conversation-1",
    sourceSequence: "12",
    telegramUserId: "telegram-user-1",
    timelineEntryId: "entry-1",
  },
  authorize: vi.fn(),
  get: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("./behavior-preference-context.js", () => ({
  requireBehaviorPreferenceAuthorization: dependencies.authorize,
}));
vi.mock("./behavior-preference-repository.js", () => ({
  behaviorPreferenceRepository: {
    get: dependencies.get,
    mutate: dependencies.mutate,
  },
}));

import manageBehaviorPreference from "./tools/manage_behavior_preference.js";

const context = { callId: "call-1" } as ToolContext;

function approvalFor(input: Record<string, unknown>) {
  return (manageBehaviorPreference.approval as (context: never) => unknown)(
    { toolInput: input } as never,
  );
}

describe("manage_behavior_preference model input", () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockReturnValue(dependencies.authorization);
    dependencies.get.mockReset().mockResolvedValue({ content: "", revision: 0, updatedAt: null });
    dependencies.mutate.mockReset().mockResolvedValue({ content: "Новый prompt", revision: 2 });
  });

  it("publishes four simple actions and no category, scope, or identity", () => {
    const schema = z.toJSONSchema(manageBehaviorPreference.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.properties.action?.enum).toEqual(["get", "append", "replace", "clear"]);
    for (const forbidden of ["preference", "value", "rules", "scope", "chatId", "userId"]) {
      expect(schema.properties).not.toHaveProperty(forbidden);
    }
  });

  it.each(["append", "replace"] as const)("routes action=%s with complete text and revision", async (action) => {
    const input = { action, content: "Отвечай без шуток.", expectedRevision: 1 };

    expect(approvalFor(input)).toBe("not-applicable");
    await manageBehaviorPreference.execute(input, context);
    expect(dependencies.mutate).toHaveBeenCalledWith(
      dependencies.authorization,
      input,
    );
  });

  it("gets the current prompt without mutation", async () => {
    await manageBehaviorPreference.execute({ action: "get" }, context);

    expect(dependencies.get).toHaveBeenCalledWith(dependencies.authorization);
    expect(dependencies.mutate).not.toHaveBeenCalled();
  });

  it("clears the whole prompt by its visible revision", async () => {
    const input = { action: "clear" as const, expectedRevision: 5 };

    expect(approvalFor(input)).toBe("not-applicable");
    await manageBehaviorPreference.execute(input, context);
    expect(dependencies.mutate).toHaveBeenCalledWith(dependencies.authorization, input);
  });

  it("rejects missing revisions, empty text, and obsolete category fields", async () => {
    for (const input of [
      { action: "replace", content: "Новый prompt" },
      { action: "append", content: "   ", expectedRevision: 1 },
      { action: "clear" },
      { action: "replace", content: "Текст", expectedRevision: 1, preference: "tone" },
    ]) {
      await expect(manageBehaviorPreference.execute(input as never, context)).rejects.toThrowError(
        /AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID/u,
      );
    }
    expect(dependencies.mutate).not.toHaveBeenCalled();
  });
});
