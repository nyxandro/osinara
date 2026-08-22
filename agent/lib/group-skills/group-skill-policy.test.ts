/**
 * Group skill policy tests.
 *
 * Constructs covered:
 * - The code-reviewed external catalog rejects unknown and duplicate persisted grants.
 * - Private chats see safe skills while groups receive only their live persisted allowlist.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import {
  GROUP_SAFE_SKILL_NAMES,
  parseGroupSkillAllowlist,
} from "./group-skill-catalog.js";
import { GROUP_SAFE_SKILL_DEFINITIONS } from "./group-skill-definitions.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES } from "./trusted-google-workspace-skills.js";
import { createConversationSkillResolver } from "./group-skill-resolver.js";

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
  it("starts with only the reviewed pohuy skill and rejects corrupt persisted lists", () => {
    expect(GROUP_SAFE_SKILL_NAMES).toEqual(["pohuy"]);
    expect(parseGroupSkillAllowlist(["pohuy"])).toEqual(new Set(["pohuy"]));
    expect(parseGroupSkillAllowlist(["unknown"])).toBeNull();
    expect(parseGroupSkillAllowlist(["pohuy", "pohuy"])).toBeNull();
  });

  it("uses the verified external grant snapshot for the whole turn", async () => {
    const loadGroupSkillAllowlist = vi.fn();
    const resolve = createConversationSkillResolver({ loadGroupSkillAllowlist });

    await expect(resolve(auth("external", ["pohuy"]))).resolves.toHaveProperty("pohuy");
    await expect(resolve(auth("external"))).resolves.toEqual({});
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
  });

  it("keeps safe skills available in private chat without a group database lookup", async () => {
    const loadGroupSkillAllowlist = vi.fn();
    const resolve = createConversationSkillResolver({ loadGroupSkillAllowlist });

    await expect(resolve(auth("private"))).resolves.toHaveProperty("pohuy");
    const skills = await resolve(auth("private"));
    expect(skills).toHaveProperty("imagegen");
    await expect(resolve(auth("private"), { subagent: true })).resolves.not.toHaveProperty("imagegen");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).toHaveProperty(name);
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
  });

  it("ties external imagegen instructions to the generate_image capability", async () => {
    const resolve = createConversationSkillResolver({ loadGroupSkillAllowlist: vi.fn() });

    await expect(resolve(auth("external", [], ["generate_image"])))
      .resolves.toHaveProperty("imagegen");
    await expect(resolve(auth("external", [], ["generate_image"]), { scheduledRun: true }))
      .resolves.not.toHaveProperty("imagegen");
    await expect(resolve(auth("external", [], ["generate_image"]), { subagent: true }))
      .resolves.not.toHaveProperty("imagegen");
    await expect(resolve(auth("external"))).resolves.not.toHaveProperty("imagegen");
  });

  it("does not advertise trusted-only Google Workspace skills to an external group", async () => {
    const resolve = createConversationSkillResolver({
      loadGroupSkillAllowlist: vi.fn().mockResolvedValue(new Set(["pohuy"])),
    });

    const skills = await resolve(auth("external", ["pohuy"]));

    expect(skills).toHaveProperty("pohuy");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) {
      expect(skills).not.toHaveProperty(name);
    }
  });

  it("keeps every source file of a grantable external skill free of artificial punctuation", () => {
    const skill = GROUP_SAFE_SKILL_DEFINITIONS.pohuy as unknown as {
      description: string;
      files: Readonly<Record<string, string>>;
      markdown: string;
    };
    const authoredText = [skill.description, skill.markdown, ...Object.values(skill.files)].join("\n");

    expect(authoredText).not.toMatch(/[—–«»]/u);
  });
});
