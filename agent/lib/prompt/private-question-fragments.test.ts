/**
 * The instructions of a private question's turn: the group's rules without live-chat sections, plus the
 * private ones. Wording is checked by reading the diff and in a live chat; this checks the composition.
 */
import { describe, expect, it } from "vitest";

import { GROUP_RESPONSE_OUTCOMES, GROUP_STANDALONE_MESSAGE_RULES } from "./group-fragments.js";
import { modeInstructions } from "./mode-instructions.js";
import { PRIVATE_QUESTION_RULES, withPrivateQuestionRules } from "./private-question-fragments.js";

describe("withPrivateQuestionRules", () => {
  it("adds the private rules to an external group's rules built as a turn that posts nothing itself", () => {
    const rules = withPrivateQuestionRules(modeInstructions({
      capabilities: new Set(["search_memories"]), environment: "external", includeApplicationCore: true, scheduledRun: true,
    }), "external");
    expect(rules).toContain(PRIVATE_QUESTION_RULES);
    expect(rules).toContain("`group-reminders`");
    expect(rules).not.toContain(GROUP_RESPONSE_OUTCOMES);
    expect(rules).not.toContain(GROUP_STANDALONE_MESSAGE_RULES);
  });

  it("asks a family group's private reminder for the chat's scope", () => {
    const rules = withPrivateQuestionRules(modeInstructions({ environment: "family", scheduledRun: true }), "family");
    expect(rules).toContain(PRIVATE_QUESTION_RULES);
    expect(rules).toContain("scope `family`");
    expect(rules).not.toContain(GROUP_RESPONSE_OUTCOMES);
  });
});
