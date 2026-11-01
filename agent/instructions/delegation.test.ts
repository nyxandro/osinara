/**
 * Who is told to delegate.
 *
 * Constructs covered:
 * - `delegationInstructions`: a root turn that has the `agent` tool gets the delegation rules; a
 *   child, a channel-authored turn and an external turn without a verified group policy, which get
 *   no `agent` (`agent/tools/capabilities.ts`), are not told to hand work to it.
 */
import { describe, expect, it } from "vitest";

import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";
import { delegationInstructions } from "./delegation.js";

function context(current: Record<string, unknown>, channel = "telegram") {
  return { channel: { kind: channel }, session: { auth: { current, initiator: null } }, turnId: "turn-1" } as never;
}

const PRIVATE_USER = {
  attributes: { familyId: "family-1", memoryScopes: ["personal", "family"], role: "owner", telegramActorId: "101", telegramActorKind: "telegram_user", telegramChatType: "private", telegramUserId: "101" },
  authenticator: "telegram", principalId: "user-1", principalType: "user",
};
const EXTERNAL_PARTICIPANT = {
  attributes: { familyId: "family-1", groupId: "group-1", groupType: "external", memoryScopes: ["group"], role: "external", telegramActorId: "202", telegramActorKind: "telegram_user", telegramChatType: "supergroup", telegramUserId: "202", toolAllowlist: [] },
  authenticator: "telegram", principalId: "user-2", principalType: "user",
};
const CHANNEL_POST = {
  attributes: { familyId: "family-1", groupId: "group-1", groupType: "external", memoryScopes: ["group"], role: "external", telegramActorId: "-100123", telegramActorKind: "telegram_channel", telegramChatType: "supergroup", toolAllowlist: [] },
  authenticator: "telegram", principalId: "telegram-channel:-100123", principalType: "service",
};

describe("delegationInstructions", () => {
  it("tells a root turn that has the agent tool how to delegate", async () => {
    for (const caller of [PRIVATE_USER, EXTERNAL_PARTICIPANT]) {
      await expect(Promise.resolve(delegationInstructions.resolve(context(caller))))
        .resolves.toEqual({ content: ORCHESTRATOR_DELEGATION_RULES, role: "system" });
    }
  });

  it("says nothing where no agent tool is given", async () => {
    const withoutGroup = { ...EXTERNAL_PARTICIPANT, attributes: { ...EXTERNAL_PARTICIPANT.attributes, groupId: undefined } };
    for (const ctx of [context(PRIVATE_USER, "subagent"), context(CHANNEL_POST), context(withoutGroup)]) {
      await expect(Promise.resolve(delegationInstructions.resolve(ctx))).resolves.toBeNull();
    }
  });
});
