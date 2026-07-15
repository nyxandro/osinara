/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - Exact authored tool-file allowlist after CRUD consolidation.
 * - Exact native skill package directories, with no TypeScript pseudo-skills.
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
  "manage_google_workspace_connection.ts",
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
  "gws-calendar",
  "gws-calendar-agenda",
  "gws-calendar-insert",
  "gws-docs",
  "gws-docs-write",
  "gws-drive",
  "gws-drive-upload",
  "gws-gmail",
  "gws-gmail-forward",
  "gws-gmail-read",
  "gws-gmail-reply",
  "gws-gmail-reply-all",
  "gws-gmail-send",
  "gws-gmail-triage",
  "gws-gmail-watch",
  "gws-shared",
  "gws-sheets",
  "gws-sheets-append",
  "gws-sheets-read",
  "pdf",
  "skill-creator",
  "t-invest",
  "xlsx",
] as const;

describe("agent capability surface", () => {
  it("exposes only the consolidated authored tool files", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolFiles).toEqual([...EXPECTED_TOOL_FILES]);
  });

  it("keeps skills as native Eve packages only", async () => {
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
    expect(skillFiles).toEqual([]);
  });

  it("requires every native skill package to declare SKILL.md", async () => {
    await Promise.all(
      EXPECTED_SKILL_DIRECTORIES.map(async (skillName) => {
        const files = await readdir(`${AGENT_ROOT}/skills/${skillName}`);

        expect(files).toContain("SKILL.md");
      }),
    );
  });
});
