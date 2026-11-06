/**
 * What a private question's turn may read besides its tools: the chat's notes, and only the service skills
 * of its own tools (#467).
 */
import { describe, expect, it } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import { requireBehaviorPreferenceReadAuthorization } from "../behavior-preference-context.js";
import { resolveConversationSkills } from "../group-skills/group-skill-resolver.js";

function auth(groupType: "external" | "family_private"): SessionAuth {
  return {
    current: {
      attributes: {
        applicationSessionId: "app-1", familyId: "family", groupId: "group", groupType,
        memoryScopes: [groupType === "external" ? "group" : "family"], privateQuestion: "true", privateQuestionId: "q-1",
        role: groupType === "external" ? "external" : "member", skillAllowlist: [], telegramActorId: "111",
        telegramActorKind: "telegram_user", telegramChatId: "-1001", telegramChatType: "supergroup",
        telegramConversationId: "conversation-1", telegramUserId: "111",
        ...(groupType === "external" ? { toolAllowlist: ["search_memories"] } : {}),
      },
      authenticator: "telegram",
      principalId: groupType === "external" ? "telegram:111" : "user-1",
      principalType: "user",
    },
    initiator: null,
  } as unknown as SessionAuth;
}

describe("private question context access", () => {
  it("reads the chat's notes without a message in the chat's timeline", () => {
    expect(requireBehaviorPreferenceReadAuthorization({ session: { auth: auth("external") } } as never)).toEqual({
      conversationId: "conversation-1", familyId: "family", groupId: "group", kind: "private_question", telegramChatId: "-1001",
    });
  });

  it("gets only the service skills of its tools, none of the group's or the release's", async () => {
    const withReminders = await resolveConversationSkills(auth("external"), { toolNames: new Set(["manage_reminder", "load_skill"]) });
    expect(Object.keys(withReminders)).toEqual(["group-reminders"]);
    const family = await resolveConversationSkills(auth("family_private"), { toolNames: new Set(["search_memories"]) });
    expect(Object.keys(family)).toEqual([]);
  });
});
