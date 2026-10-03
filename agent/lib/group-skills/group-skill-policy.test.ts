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

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import {
  GROUP_SAFE_SKILL_NAMES,
  parseGroupSkillAllowlist,
} from "./group-skill-catalog.js";
import { GROUP_SAFE_SKILL_DEFINITIONS } from "./group-skill-definitions.js";
import { resolveConversationSkills } from "./group-skill-resolver.js";
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
    expect(GROUP_SAFE_SKILL_NAMES).toEqual(expect.arrayContaining(["pohuy", "agent-browser", "docx", "pdf", "xlsx"]));
    expect(parseGroupSkillAllowlist(["pohuy", "weather"])).toEqual(new Set(["pohuy", "weather"]));
    expect(parseGroupSkillAllowlist(["../escape"])).toBeNull();
    expect(parseGroupSkillAllowlist(["pohuy", "pohuy"])).toBeNull();
    expect(Object.keys(await resolveConversationSkills(auth("external", ["weather", "pohuy"])))).toEqual(["pohuy"]);
  });

  it("gives private and family conversations all installed skills while external grants stay exact", async () => {
    const resolve = resolveConversationSkills;
    for (const mode of ["private", "family"] as const) {
      const skills = await resolve(auth(mode));
      for (const name of GROUP_SAFE_SKILL_NAMES) expect(skills).toHaveProperty(name);
    }
    expect(Object.keys(await resolve(auth("external", ["agent-browser", "pdf"])))).toEqual(["agent-browser", "pdf"]);
    expect(await resolve(auth("external"))).toEqual({});
  });

  it("uses the verified external grant snapshot for the whole turn", async () => {
    const resolve = resolveConversationSkills;

    await expect(resolve(auth("external", ["pohuy"]))).resolves.toHaveProperty("pohuy");
    await expect(resolve(auth("external"))).resolves.toEqual({});
  });

  it("keeps safe skills available in private chat without a group database lookup", async () => {
    const resolve = resolveConversationSkills;

    await expect(resolve(auth("private"))).resolves.toHaveProperty("pohuy");
    const skills = await resolve(auth("private"));
    expect(skills).toHaveProperty("imagegen");
    await expect(resolve(auth("private"), { subagent: true })).resolves.not.toHaveProperty("imagegen");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).toHaveProperty(name);
  });

  it("ties external imagegen instructions to the generate_image capability", async () => {
    const resolve = resolveConversationSkills;

    await expect(resolve(auth("external", [], ["generate_image"])))
      .resolves.toHaveProperty("imagegen");
    await expect(resolve(auth("external", [], ["generate_image"]), { scheduledRun: true }))
      .resolves.not.toHaveProperty("imagegen");
    await expect(resolve(auth("external", [], ["generate_image"]), { subagent: true }))
      .resolves.not.toHaveProperty("imagegen");
    await expect(resolve(auth("external"))).resolves.not.toHaveProperty("imagegen");
  });

  it("does not advertise trusted-only Google Workspace skills to an external group", async () => {
    const resolve = resolveConversationSkills;

    const skills = await resolve(auth("external", ["pohuy"]));

    expect(skills).toHaveProperty("pohuy");
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
