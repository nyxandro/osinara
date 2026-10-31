/**
 * Group skill policy tests.
 *
 * Constructs covered:
 * - A persisted group list is rejected whole when a name is malformed or repeated; a well-formed
 *   name that is no skill now is simply not given out.
 * - Private chats see safe skills while groups receive only their live persisted allowlist.
 */
import type { SessionAuth } from "../../runtime/context.js";
import { describe, expect, it, vi } from "vitest";

import {
  GROUP_SAFE_SKILL_NAMES,
  parseGroupSkillAllowlist,
} from "./group-skill-catalog.js";
import { GROUP_SAFE_SKILL_DEFINITIONS } from "./group-skill-definitions.js";
import { resolveConversationSkills } from "./group-skill-resolver.js";
const NO_TOOLS = { toolNames: new Set<string>() };
const TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES = GROUP_SAFE_SKILL_NAMES.filter((name) => name.startsWith("gws-"));

function auth(
  environment: "external" | "family" | "private",
  skillAllowlist: string[] = [],
  toolAllowlist: string[] = [],
): SessionAuth {
  const group = environment !== "private";
  const caller = {
    attributes: {
      ...(group ? { groupId: "00000000-0000-4000-8000-000000000041" } : {}),
      ...(group ? { groupType: environment === "external" ? "external" : "family_private" } : {}),
      memoryScopes: environment === "private"
        ? ["personal", "family"]
        : [environment === "external" ? "group" : "family"],
      ...(group ? { skillAllowlist } : {}),
      ...(group ? { toolAllowlist } : {}),
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatType: group ? "group" : "private",
      telegramUserId: "101",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

describe("group skill policy", () => {
  it("lists installed skills and rejects corrupt persisted lists", async () => {
    expect(GROUP_SAFE_SKILL_NAMES).toEqual(expect.arrayContaining(["behavior-preferences", "agent-browser", "docx", "pdf", "xlsx"]));
    expect(parseGroupSkillAllowlist(["behavior-preferences", "weather"])).toEqual(new Set(["behavior-preferences", "weather"]));
    expect(parseGroupSkillAllowlist(["../escape"])).toBeNull();
    expect(parseGroupSkillAllowlist(["behavior-preferences", "behavior-preferences"])).toBeNull();
    expect(Object.keys(await resolveConversationSkills(auth("external", ["weather", "behavior-preferences"]), NO_TOOLS))).toEqual(["behavior-preferences"]);
  });

  it("gives private and family conversations all installed skills while external grants stay exact", async () => {
    const resolve = resolveConversationSkills;
    for (const mode of ["private", "family"] as const) {
      const skills = await resolve(auth(mode), NO_TOOLS);
      for (const name of GROUP_SAFE_SKILL_NAMES) expect(skills).toHaveProperty(name);
    }
    expect(Object.keys(await resolve(auth("external", ["agent-browser", "pdf"]), NO_TOOLS))).toEqual(["agent-browser", "pdf"]);
    expect(await resolve(auth("external"), NO_TOOLS)).toEqual({});
  });

  it("gives a service skill only where the turn has its tool", async () => {
    const resolve = resolveConversationSkills;
    const withSkillTool = { toolNames: new Set(["manage_skill"]) };

    await expect(resolve(auth("private"), withSkillTool)).resolves.toHaveProperty("skill-manager");
    // A scheduled run or a delegated child has no manage_skill, so no skill-manager either.
    await expect(resolve(auth("private"), { toolNames: new Set(["manage_reminder"]) })).resolves.not.toHaveProperty("skill-manager");
    await expect(resolve(auth("family"), withSkillTool)).resolves.not.toHaveProperty("skill-manager");
    await expect(resolve(auth("external", ["skill-manager"]), withSkillTool)).resolves.not.toHaveProperty("skill-manager");
    await expect(resolve(auth("external"), { toolNames: new Set(["manage_reminder"]) })).resolves.toHaveProperty("group-reminders");
  });

  it("uses the verified external grant snapshot for the whole turn", async () => {
    const resolve = resolveConversationSkills;

    await expect(resolve(auth("external", ["behavior-preferences"]), NO_TOOLS)).resolves.toHaveProperty("behavior-preferences");
    await expect(resolve(auth("external"), NO_TOOLS)).resolves.toEqual({});
  });

  it("keeps safe skills available in private chat without a group database lookup", async () => {
    const resolve = resolveConversationSkills;

    await expect(resolve(auth("private"), NO_TOOLS)).resolves.toHaveProperty("behavior-preferences");
    const skills = await resolve(auth("private"), NO_TOOLS);
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).toHaveProperty(name);
  });

  it("does not advertise trusted-only Google Workspace skills to an external group", async () => {
    const resolve = resolveConversationSkills;

    const skills = await resolve(auth("external", ["behavior-preferences"]), NO_TOOLS);

    expect(skills).toHaveProperty("behavior-preferences");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) {
      expect(skills).not.toHaveProperty(name);
    }
  });

  // Stage 0 finding: the model saw `>-` as the description of a skill with a YAML block scalar.
  it("reads a multi-line description of a built-in skill in full", () => {
    const description = GROUP_SAFE_SKILL_DEFINITIONS["find-docs"]!.description;
    expect(description).toMatch(/^Retrieves up-to-date documentation, API references, and code examples for any developer technology\. /u);
    expect(description).toContain(" Spring Boot. Your training data");
    expect(description).toContain("version updates.\nAlways use for: API syntax questions");
  });

  it("keeps every source file of a grantable external skill free of artificial punctuation", () => {
    for (const [name, definition] of Object.entries(GROUP_SAFE_SKILL_DEFINITIONS)) {
    const skill = definition as unknown as {
      description: string;
      files: Readonly<Record<string, string>>;
      markdown: string;
    };
    const authoredText = [skill.description, skill.markdown, ...Object.values(skill.files)].join("\n");

    expect(authoredText, name).not.toMatch(/[—–«»]/u);
    }
  });
});
