/**
 * Native Google Workspace gws skill package tests.
 *
 * Constructs covered:
 * - Official `googleworkspace/cli` service skills are installed as Eve skill packages.
 * - Shared instructions adapt authentication to Osinara's workspace-bound credentials.
 * - Authored examples stay executable through the exact argv allowlist and one-shot runner.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyGoogleWorkspaceCommand } from "./google-workspace-command-policy.js";
import { GROUP_SAFE_SKILL_DEFINITIONS } from "../group-skills/group-skill-definitions.js";
import { GOOGLE_WORKSPACE_EXECUTION_GUIDE } from "./google-workspace-skill-instructions.js";

const serviceSkills = [
  "gws-calendar",
  "gws-calendar-agenda",
  "gws-calendar-insert",
  "gws-docs",
  "gws-docs-write",
  "gws-drive",
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
  return await readFile(
    new URL(`../../../config/skills/${skillName}/SKILL.md`, import.meta.url),
    "utf8",
  );
}

function exampleArgv(command: string): string[] {
  return (command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/gu) ?? [])
    .map((argument) => argument.replace(/^(['"])(.*)\1$/u, "$2"));
}

describe("Google Workspace gws skill packages", () => {
  it("loads the execution contract with every individual Google skill and validates its JSON calls", async () => {
    for (const name of serviceSkills) {
      const skill = GROUP_SAFE_SKILL_DEFINITIONS[name];
      expect(skill.markdown.startsWith(GOOGLE_WORKSPACE_EXECUTION_GUIDE)).toBe(true);
      for (const line of skill.markdown.split("\n").filter(line => line.startsWith('{"argv":'))) {
        expect(() => classifyGoogleWorkspaceCommand(JSON.parse(line).argv), `${name}: ${line}`).not.toThrow();
      }
    }
    for (const name of ["gws-gmail", "gws-gmail-triage", "gws-calendar-agenda"]) {
      const examples = (await readSkill(name)).split("\n").filter(line => line.startsWith('{"argv":'));
      expect(examples.length).toBeGreaterThan(0);
      for (const line of examples) expect(classifyGoogleWorkspaceCommand(JSON.parse(line).argv)).toBe("read");
    }
  });
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
        expect(skill).not.toMatch(/(^|[^a-z_])google_workspace([^a-z_]|$)/u);
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
    expect(shared).toContain("execute_google_workspace");
    expect(shared).toContain("manage_google_workspace_connection");
    expect(shared).toContain("gws auth login");
    expect(shared).toContain("`ask_question` as a substitute");
    expect(shared).toContain("automatic Eve HITL");
    expect(shared).toContain("Do not automatically retry failed `gws` mutations");
    expect(shared).toContain("Do not pass `--upload`, `--output`, `--output-dir`, `--attach`, `-a`, or `-o`");
  });

  it("documents Google People contact mutation policy", async () => {
    const people = await readSkill("gws-people");

    expect(people).toContain("createContact");
    expect(people).toContain("updateContact");
    expect(people).toContain("deleteContact");
    expect(people).toContain("batchCreateContacts");
    expect(people).toContain("execute_google_workspace supplies mandatory Eve HITL");
    expect(people).toContain("Update a contact through mandatory Eve HITL");
    expect(people).toContain("metadata.sources.etag");
  });

  it("routes message state changes as one batch through the structured Gmail boundary", async () => {
    const gmail = await readSkill("gws-gmail");

    expect(gmail).toContain("manage_gmail_message");
    expect(gmail).toContain('{"action":"trash","messageIds":["MESSAGE_ID_1","MESSAGE_ID_2"],"profileRef":"PROFILE_REF"}');
    expect(gmail).toContain('{"action":"delete","messageIds":["MESSAGE_ID"],"profileRef":"PROFILE_REF"}');
    expect(gmail).toContain('{"action":"mark_read","messageIds":["MESSAGE_ID_1","MESSAGE_ID_2"],"profileRef":"PROFILE_REF"}');
    expect(gmail).not.toContain('"messageId":');
    expect(gmail).not.toContain('["gmail", "users", "messages", "trash"');
    expect(gmail).not.toContain('["gmail", "users", "messages", "delete"');
    expect(gmail).not.toContain('["gmail", "users", "messages", "modify"');
    expect(gmail).toMatch(/Do not combine resource and\s+method segments/u);
  });

  it("contains no runtime generation fallback, shell pipeline, or duplicate confirmation flow", async () => {
    const skills = await Promise.all(serviceSkills.map(readSkill));
    const joined = skills.join("\n");

    expect(joined).not.toContain("gws generate-skills");
    expect(joined).not.toMatch(/gws [^\n]+\|/u);
    expect(joined).not.toContain("confirm with the user before executing");
    expect(joined).toContain("provides the only required Eve HITL confirmation");
  });

  it("keeps helper examples within route flags and Gmail watch bounded", async () => {
    const agenda = await readSkill("gws-calendar-agenda");
    const gmail = await readSkill("gws-gmail");
    const triage = await readSkill("gws-gmail-triage");
    const watch = await readSkill("gws-gmail-watch");

    expect(agenda).not.toMatch(/\+agenda[^\n]*--format/u);
    expect(triage).not.toMatch(/\+triage[^\n]*--format/u);
    expect(gmail).toContain("Pull one bounded batch of new emails");
    expect(gmail).not.toContain("stream them as NDJSON");
    expect(watch).toMatch(/\| `--once` \| ✔ \|/u);
    expect(watch).toContain("`--once` is mandatory");
    const watchExamples = watch.split("\n").filter((line) => line.startsWith("gws gmail +watch "));
    expect(watchExamples.every((line) => line.includes("--once"))).toBe(true);
  });

  it("keeps every self-contained gws example executable through the argv policy", async () => {
    for (const skillName of serviceSkills) {
      const lines = (await readSkill(skillName)).split("\n");
      const examples = lines.filter((line) =>
        line.startsWith("gws ") &&
        !line.endsWith("\\") &&
        !line.includes("|") &&
        !line.startsWith("gws auth ") &&
        !line.startsWith("gws <") &&
        !line.startsWith("gws schema <") &&
        !line.includes("<resource>") &&
        !line.includes("<method>")
      );

      for (const example of examples) {
        expect(
          () => classifyGoogleWorkspaceCommand(exampleArgv(example.slice("gws ".length))),
          `${skillName}: ${example}`,
        ).not.toThrow();
      }
    }
  });
});
