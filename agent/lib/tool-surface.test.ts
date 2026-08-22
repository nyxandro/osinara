/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - `agent/tools` holds only the dynamic resolver; native `agent` supplies fresh-context delegation.
 * - Exact application tool-module allowlist after CRUD consolidation.
 * - Exact static package directories plus the single dynamic policy resolver.
 * - The opt-in tone skill lives outside static Eve discovery.
 * - The compiled dynamic resolver stays step-scoped and avoids durable helper-closure replay.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_TOOL_MODULES = [
  "execute_google_workspace.ts",
  "export_memory.ts",
  "generate_image.ts",
  "get_current_time.ts",
  "get_memory_source.ts",
  "import_telegram_attachment.ts",
  "inspect_workspace_image.ts",
  "list_agent_schedules.ts",
  "list_group_history.ts",
  "list_memories.ts",
  "list_memory_threads.ts",
  "list_pending_family_invitations.ts",
  "list_proactive_deliveries.ts",
  "list_reminders.ts",
  "list_telegram_attachments.ts",
  "manage_agent_schedule.ts",
  "manage_behavior_preference.ts",
  "manage_external_group_schedule.ts",
  "manage_family_invitation.ts",
  "manage_google_workspace_connection.ts",
  "manage_memory.ts",
  "manage_memory_conflict.ts",
  "manage_memory_thread.ts",
  "manage_profile_projection.ts",
  "manage_reminder.ts",
  "manage_telegram_group.ts",
  "notification_settings.ts",
  "read_memory_thread.ts",
  "read_profile_view.ts",
  "read_scheduled_group_history.ts",
  "remember.ts",
  "search_memories.ts",
  "search_memory_threads.ts",
  "send_workspace_file.ts",
  "start_new_context.ts",
] as const;

const EXPECTED_DISCOVERED_TOOL_FILES = ["capabilities.ts"] as const;

const EXPECTED_SKILL_DIRECTORIES = [
  "agent-browser",
  "behavior-preferences",
  "docx",
  "find-docs",
  "pdf",
  "t-invest",
  "xlsx",
] as const;

describe("agent capability surface", () => {
  it("discovers only the dynamic resolver so Eve provides native delegation", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolFiles).toEqual([...EXPECTED_DISCOVERED_TOOL_FILES]);
  });

  it("keeps every application tool implementation outside Eve discovery", async () => {
    const entries = await readdir(`${AGENT_ROOT}/lib/tools`, { withFileTypes: true });
    const toolModules = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolModules).toEqual([...EXPECTED_TOOL_MODULES]);
  });

  it("keeps static packages separate from the dynamic policy resolver", async () => {
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
    expect(skillFiles).toEqual(["scoped.ts"]);
  });

  it("keeps the opt-in profanity package outside static discovery", async () => {
    const packageRoot = resolve(AGENT_ROOT, "../config/group-skills/pohuy");
    const skill = await readFile(`${packageRoot}/instructions.md`, "utf8");
    const definitions = await readFile(
      `${AGENT_ROOT}/lib/group-skills/group-skill-definitions.ts`,
      "utf8",
    );

    // Activation guidance is emitted only when policy grants this dynamic skill.
    expect(definitions).toContain("Загружай только по явной просьбе");

    // The dynamic definition ships all sibling references with the sandbox package.
    const references = await readdir(`${packageRoot}/references`);
    expect(references.sort()).toEqual(["ontologia.md", "sceny.md", "slovar.md"]);

    // The vendored copy must not try to reach the upstream repository from the sandbox.
    expect(skill).not.toContain("raw.githubusercontent.com");
  });

  it("requires every native skill package to declare SKILL.md", async () => {
    await Promise.all(
      EXPECTED_SKILL_DIRECTORIES.map(async (skillName) => {
        const files = await readdir(`${AGENT_ROOT}/skills/${skillName}`);

        expect(files).toContain("SKILL.md");
      }),
    );
  });

  it("authors the whole dynamic tool surface at step scope", async () => {
    const source = await readFile(`${AGENT_ROOT}/tools/capabilities.ts`, "utf8");

    expect(source).toContain('"step.started": async');
    expect(source).not.toContain('"turn.started"');
  });
});
