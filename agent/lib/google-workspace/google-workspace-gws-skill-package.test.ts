/**
 * Native Google Workspace gws skill package tests.
 *
 * Constructs covered:
 * - Official `googleworkspace/cli` service skills are installed as Eve skill packages.
 * - Shared instructions adapt authentication to Osinara's workspace-bound credentials.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const serviceSkills = [
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
  "gws-people",
  "gws-sheets",
  "gws-sheets-append",
  "gws-sheets-read",
] as const;

const apiSurfaceSkills = [
  "gws-calendar",
  "gws-docs",
  "gws-drive",
  "gws-gmail",
  "gws-people",
  "gws-sheets",
] as const;

async function readSkill(skillName: string): Promise<string> {
  return await readFile(new URL(`../../skills/${skillName}/SKILL.md`, import.meta.url), "utf8");
}

describe("Google Workspace gws skill packages", () => {
  it("installs official googleworkspace/cli service packages", async () => {
    await Promise.all(
      serviceSkills.map(async (skillName) => {
        const skill = await readSkill(skillName);

        expect(skill).toContain(`name: ${skillName}`);
        expect(skill).toContain('version: "0.22.5"');
        expect(skill).toContain('openclaw: "category=productivity;requires=bins:gws"');
      }),
    );
  });

  it("keeps service packages linked to the shared gws runtime guide", async () => {
    await Promise.all(
      serviceSkills.map(async (skillName) => {
        const skill = await readSkill(skillName);

        expect(skill).toContain("../gws-shared/SKILL.md");
        expect(skill).not.toContain("google_workspace");
      }),
    );
  });

  it("keeps API surface skills grounded in gws schema discovery", async () => {
    await Promise.all(
      apiSurfaceSkills.map(async (skillName) => {
        const skill = await readSkill(skillName);

        expect(skill).toContain("gws schema");
      }),
    );
  });

  it("adapts shared authentication to Osinara's credential boundary", async () => {
    const shared = await readSkill("gws-shared");

    expect(shared).toContain("name: gws-shared");
    expect(shared).toContain("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE");
    expect(shared).toContain("manage_google_workspace_connection");
    expect(shared).toContain("gws auth login");
    expect(shared).toContain("ask_question");
    expect(shared).toContain("service-specific confirmation rules");
    expect(shared).toContain("Do not automatically retry failed `gws` mutations");
  });

  it("documents Google People contact mutation policy", async () => {
    const people = await readSkill("gws-people");

    expect(people).toContain("createContact");
    expect(people).toContain("updateContact");
    expect(people).toContain("deleteContact");
    expect(people).toContain("batchCreateContacts");
    expect(people).toContain("delete and batch operations require explicit user confirmation");
    expect(people).toContain("create and update operations do not require an extra confirmation");
    expect(people).toContain("metadata.sources.etag");
  });
});
