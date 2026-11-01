/**
 * The mode block of a delegated child turn.
 *
 * Constructs covered:
 * - `modeInstructions` with `subagentTurn`: a child is told it works for the calling agent and gets
 *   none of the rules for what it cannot do — saving or editing memory, reminders and scenarios,
 *   administration, progress notes to the person, joining the group's conversation, showing a file
 *   to the chat, delegating further.
 * - The live turn of the same chat keeps all of them and gets no child rules.
 */
import { describe, expect, it } from "vitest";

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  GROUP_MEMORY_DELTA_CONTRACT,
  MEMORY_EXACT_DUPLICATE_HANDLING,
  MEMORY_WRITE_CONTRACT,
} from "./common-fragments.js";
import { SUBAGENT_TURN_RULES } from "./delegation-fragments.js";
import { GROUP_REMINDER_RULES } from "./external-fragments.js";
import { GROUP_ADDRESSING } from "./group-fragments.js";
import { modeInstructions, type ModeInstructionsInput } from "./mode-instructions.js";
import { PROGRESS_UPDATE_RULES, START_NEW_CONTEXT_RULES, trustedScheduleRules } from "./trusted-fragments.js";

// The grants of the live external group on production, memory editing and saving included.
const LIVE_GROUP_GRANTS = new Set<ExternalGroupToolName>([
  "bash", "import_telegram_attachment", "inspect_workspace_image", "list_memories", "list_memory_threads",
  "list_group_history", "manage_memory.delete", "manage_memory.edit", "manage_memory.undo",
  "manage_memory_thread.complete", "manage_memory_thread.reactivate", "read_memory_thread", "remember",
  "remove_group_file", "search_memories", "search_memory_threads",
] as ExternalGroupToolName[]);

const CHATS: Array<[string, ModeInstructionsInput]> = [
  ["the private chat", { environment: "private" }],
  ["the family group", { environment: "family" }],
  ["an external group", { capabilities: LIVE_GROUP_GRANTS, environment: "external" }],
];

// What a child cannot act on, by the text that teaches it.
const CHILD_CANNOT = [
  ["saving memory", MEMORY_WRITE_CONTRACT],
  ["the group's memory delta", GROUP_MEMORY_DELTA_CONTRACT],
  ["duplicate cleanup", MEMORY_EXACT_DUPLICATE_HANDLING],
  ["memory edits", "For `manage_memory` use only the explicit JSON contract"],
  ["progress notes to the person", PROGRESS_UPDATE_RULES],
  ["a new context", START_NEW_CONTEXT_RULES],
  ["joining the group's conversation", GROUP_ADDRESSING],
  ["personal reminders and scenarios", trustedScheduleRules("personal")],
  ["family reminders and scenarios", trustedScheduleRules("family")],
  ["group reminders", GROUP_REMINDER_RULES],
  ["administration", "## Administration"],
  ["writing personal memory", "can be read and written"],
  ["exporting memory", "export_memory"],
  ["showing a file to the chat", "To send a file from a workspace"],
  ["taking part in the conversation", "You are an ordinary participant of the conversation"],
] as const;

describe("delegated child mode block", () => {
  it.each(CHATS)("in %s tells the child whom it works for and leaves out what it cannot do", (_name, input) => {
    const child = modeInstructions({ ...input, subagentTurn: true });

    expect(child).toContain(SUBAGENT_TURN_RULES);
    for (const [what, text] of CHILD_CANNOT) expect(child, what).not.toContain(text);
  });

  it("never tells a child of a scheduled group run how to delegate further", () => {
    const run = { capabilities: LIVE_GROUP_GRANTS, environment: "external", scheduledHistory: true, scheduledRun: true } as const;

    expect(modeInstructions(run)).toContain("When delegating");
    expect(modeInstructions({ ...run, subagentTurn: true })).not.toContain("When delegating");
  });

  it.each(CHATS)("in %s keeps the live turn's rules and gives it no child rules", (_name, input) => {
    const live = modeInstructions(input);
    const child = modeInstructions({ ...input, subagentTurn: true });

    expect(live).not.toContain(SUBAGENT_TURN_RULES);
    expect(live).toContain(MEMORY_WRITE_CONTRACT);
    // A child reads every page of its subtask into a fresh context: a far shorter block is the point.
    expect(child.length).toBeLessThan(live.length * 0.75);
  });
});
