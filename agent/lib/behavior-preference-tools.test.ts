/**
 * User-managed chat instruction execution tests.
 *
 * Constructs covered:
 * - Any verified participant may rewrite the one prompt of the current chat.
 * - No owner role, memory scope, or category enters the mutation boundary.
 */
import type { ToolContext } from "../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authorization: {
    conversationId: "conversation-1",
    sourceSequence: "7",
    telegramUserId: "member-telegram",
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
  behaviorPreferenceRepository: { get: dependencies.get, mutate: dependencies.mutate },
}));

import manageBehaviorPreference from "./tools/manage_behavior_preference.js";

describe("manage_behavior_preference execution", () => {
  it("passes only verified chat auth and the requested prompt mutation", async () => {
    dependencies.authorize.mockReturnValue(dependencies.authorization);
    dependencies.mutate.mockResolvedValue({ content: "Краткий prompt", revision: 2 });
    const input = {
      action: "replace" as const,
      content: "Краткий prompt",
      expectedRevision: 1,
    };

    await manageBehaviorPreference.execute(input, { callId: "call-1" } as ToolContext);

    expect(dependencies.mutate).toHaveBeenCalledWith(dependencies.authorization, input);
  });
});
