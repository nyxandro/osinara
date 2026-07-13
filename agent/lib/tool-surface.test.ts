/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - Exact authored tool-file allowlist after CRUD consolidation.
 * - Exact static package directories and dynamic skill modules.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_TOOL_FILES = [
  "export_memory.ts",
  "group-tool-policy.ts",
  "inspect_workspace_image.ts",
  "list_family_members.ts",
  "list_memories.ts",
  "list_pending_family_invitations.ts",
  "list_reminders.ts",
  "list_tasks.ts",
  "manage_behavior_preference.ts",
  "manage_family_invitation.ts",
  "manage_memory.ts",
  "manage_reminder.ts",
  "manage_task.ts",
  "manage_telegram_group.ts",
  "notification_settings.ts",
  "remember.ts",
  "search_memories.ts",
  "send_workspace_file.ts",
  "start_new_context.ts",
] as const;

const EXPECTED_SKILL_DIRECTORIES = [
  "agent-browser",
  "behavior-preferences",
  "docx",
  "find-docs",
  "find-skills",
  "pdf",
  "skill-creator",
  "xlsx",
] as const;

const EXPECTED_DYNAMIC_SKILL_FILES = ["t-invest.ts"] as const;

describe("agent capability surface", () => {
  it("exposes only the consolidated authored tool files", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolFiles).toEqual([...EXPECTED_TOOL_FILES]);
  });

  it("keeps the agreed static and scope-aware dynamic skills", async () => {
    const entries = await readdir(`${AGENT_ROOT}/skills`, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirectories).toEqual([...EXPECTED_SKILL_DIRECTORIES]);
    const skillFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(skillFiles).toEqual([...EXPECTED_DYNAMIC_SKILL_FILES]);
  });
});
