/**
 * A family's own skills from the owner's request to the turns that receive them.
 *
 * Constructs covered:
 * - A stored skill works only after the owner's button, from the next turn on; a changed one waits
 *   for its own button while the confirmed version keeps working, and a rollback is one more button.
 * - A broken package, a taken name and a missing folder are refused with a plain reason.
 * - An external group receives a family skill only after the owner adds it; disabling or deleting
 *   the skill closes that grant and leaves the group's other skills alone.
 * - A skill downloaded into the workspace is installed from there, and its card names the source.
 * - The family's working skills together stay within what a turn sends to the sandbox.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import type { ToolContext } from "../../runtime/tool.js";
import { closeDatabase, database } from "../database.js";
import { groupSkillPolicyRepository } from "../group-skills/group-skill-repository.js";
import { resolveConversationSkills } from "../group-skills/group-skill-resolver.js";
import { presentTelegramApproval } from "../telegram-hitl/approval-presentation.js";
import type { TelegramInputRequest } from "../telegram-interface.js";
import manageSkill from "../tools/manage_skill.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { WORKSPACES_ROOT } from "../workspaces/workspace-repository.js";
import { deleteWorkspaceDirectory, writeWorkspaceFile } from "../workspaces/workspace-storage.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  readonly familyId: string;
  readonly groupChatId: string;
  readonly groupId: string;
  readonly ownerId: string;
  readonly ownerTelegramId: string;
}

const workspaces = new Set<string>();

async function fixture(suffix: string): Promise<Fixture> {
  const family = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Skills ${suffix}`])).rows[0]!;
  const owner = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id", [`77${suffix}`, `Owner ${suffix}`],
  )).rows[0]!;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family.id, owner.id]);
  const group = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, $2, $3, 'external', 'addressed_only', '{}') RETURNING id`,
    [family.id, `-100${suffix}`, `Group ${suffix}`],
  )).rows[0]!;
  return { familyId: family.id, groupChatId: `-100${suffix}`, groupId: group.id, ownerId: owner.id, ownerTelegramId: `77${suffix}` };
}

function ownerAuth(f: Fixture): SessionAuth {
  const caller = {
    attributes: {
      familyId: f.familyId, memoryScopes: ["personal", "family"], role: "owner",
      telegramActorId: f.ownerTelegramId, telegramActorKind: "telegram_user", telegramChatId: f.ownerTelegramId,
      telegramChatType: "private", telegramUserId: f.ownerTelegramId,
    },
    authenticator: "telegram", principalId: f.ownerId, principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

/** The group's turn as its verified snapshot carries the current lists. */
async function groupAuth(f: Fixture): Promise<SessionAuth> {
  const row = (await database().query<{ skill_allowlist: string[]; tool_allowlist: string[] }>(
    "SELECT skill_allowlist, tool_allowlist FROM telegram_groups WHERE id = $1", [f.groupId],
  )).rows[0]!;
  const caller = {
    attributes: {
      familyId: f.familyId, groupId: f.groupId, groupType: "external", memoryScopes: ["group"], role: "member",
      skillAllowlist: row.skill_allowlist, telegramActorId: f.ownerTelegramId, telegramActorKind: "telegram_user",
      telegramChatType: "supergroup", telegramUserId: f.ownerTelegramId, toolAllowlist: row.tool_allowlist,
    },
    authenticator: "telegram", principalId: f.ownerId, principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

function ownerContext(f: Fixture): ToolContext {
  return { session: { auth: ownerAuth(f), id: `session-${f.ownerId}` } } as unknown as ToolContext;
}

async function writeFolder(f: Fixture, folder: string, files: Readonly<Record<string, string>>): Promise<void> {
  const workspaceId = await workspaceBinaryRepository.workspaceId(requireWorkspaceAuthorization(ownerContext(f)), "personal");
  workspaces.add(workspaceId);
  for (const [path, content] of Object.entries(files)) {
    await writeWorkspaceFile(WORKSPACES_ROOT, workspaceId, `${folder}/${path}`, Buffer.from(content, "utf8"));
  }
}

const weather = (description: string) => `---\nname: weather\ndescription: ${description}\n---\n# Погода\nЗапусти scripts/fetch.py.\n`;

function approvalRequest(input: Record<string, string | number>): TelegramInputRequest {
  return {
    action: { callId: "call-1", input, kind: "tool-call", toolName: "manage_skill" },
    display: "confirmation",
    kind: "tool-approval",
    options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
    prompt: "Approve tool call: manage_skill",
    requestId: "request-1",
  };
}

async function stage(f: Fixture, input: Record<string, string>) {
  return await manageSkill.execute({ action: "stage", scope: "personal", ...input }, ownerContext(f)) as { name: string; stored: string; version: number };
}

/** What the owner's button runs: the approved call, executed after the card was shown. */
async function press(f: Fixture, input: Record<string, string | number>): Promise<string> {
  expect(manageSkill.approval?.({ toolInput: input } as never)).toBe("user-approval");
  const card = await presentTelegramApproval(approvalRequest(input), ownerContext(f));
  await manageSkill.execute(input as never, ownerContext(f));
  return card.prompt;
}

/** A working skill recorded with the given size; the family-wide check reads recorded sizes. */
async function seedWorkingSkill(f: Fixture, name: string, size: number): Promise<void> {
  const skill = (await database().query<{ id: string }>(
    "INSERT INTO family_skills (family_id, name) VALUES ($1, $2) RETURNING id", [f.familyId, name],
  )).rows[0]!;
  await database().query(
    `INSERT INTO family_skill_versions (skill_id, version, description, markdown, files, content_hash, origin_kind, created_by)
     VALUES ($1, 1, 'Большой скилл', '', $2::jsonb, repeat('a', 64), 'authored', $3)`,
    [skill.id, JSON.stringify([{ content: "", executable: false, path: "data.bin", size }]), f.ownerId],
  );
  await database().query("UPDATE family_skills SET active_version = 1, enabled = true WHERE id = $1", [skill.id]);
}

describeWithDatabase("family skills", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE family_skills, workspaces, telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => {
    for (const id of workspaces) await deleteWorkspaceDirectory(WORKSPACES_ROOT, id);
    await closeDatabase();
  });

  it("works from the turn after the owner's button, in private and family chats", async () => {
    const f = await fixture("5501");
    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз погоды по городу"), "scripts/fetch.py": "print(1)" });

    await expect(stage(f, { path: "skills/weather" })).resolves.toMatchObject({ name: "weather", stored: "new_version", version: 1 });
    expect(await resolveConversationSkills(ownerAuth(f))).not.toHaveProperty("weather");

    const card = await press(f, { action: "activate", name: "weather", version: 1 });
    expect(card).toContain("Скилл: weather");
    expect(card).toContain("Описание: Прогноз погоды по городу");
    expect(card).toContain("Источник: написан агентом");
    expect(card).toContain("scripts/fetch.py — 8 Б, скрипт");

    const skills = await resolveConversationSkills(ownerAuth(f));
    expect(skills.weather).toMatchObject({ description: "Прогноз погоды по городу", markdown: "# Погода\nЗапусти scripts/fetch.py.\n" });
    expect(Buffer.from(skills.weather!.files!["scripts/fetch.py"] as Uint8Array).toString("utf8")).toBe("print(1)");
    expect(skills).toHaveProperty("pdf");
  });

  it("keeps the confirmed version working until the owner confirms a change, and rolls back by button", async () => {
    const f = await fixture("5502");
    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз v1") });
    await stage(f, { path: "skills/weather" });
    await press(f, { action: "activate", name: "weather", version: 1 });

    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз v2") });
    await expect(stage(f, { path: "skills/weather" })).resolves.toMatchObject({ stored: "new_version", version: 2 });
    await expect(stage(f, { path: "skills/weather" })).resolves.toMatchObject({ stored: "same_as_latest", version: 2 });
    expect((await resolveConversationSkills(ownerAuth(f))).weather?.description).toBe("Прогноз v1");

    const update = await press(f, { action: "activate", name: "weather", version: 2 });
    expect(update).toContain("Версия: 2, сейчас работает версия 1");
    expect((await resolveConversationSkills(ownerAuth(f))).weather?.description).toBe("Прогноз v2");

    await press(f, { action: "activate", name: "weather", version: 1 });
    expect((await resolveConversationSkills(ownerAuth(f))).weather?.description).toBe("Прогноз v1");
  });

  it("refuses a broken package, a taken name and a missing folder, saying what is wrong", async () => {
    const f = await fixture("5503");
    await writeFolder(f, "skills/broken", { "SKILL.md": "---\nname: broken\n---\nТекст\n" });
    await writeFolder(f, "skills/pdf", { "SKILL.md": "---\nname: pdf\ndescription: Свой PDF\n---\nТекст\n" });

    await expect(stage(f, { path: "skills/broken" })).rejects.toMatchObject({
      code: "AGENT_SKILL_PACKAGE_INVALID", message: expect.stringContaining("нет описания"),
    });
    await expect(stage(f, { path: "skills/pdf" })).rejects.toMatchObject({ code: "AGENT_SKILL_NAME_TAKEN" });
    await expect(stage(f, { path: "skills/none" })).rejects.toMatchObject({ code: expect.stringMatching(/^AGENT_(SKILL_PACKAGE_INVALID|WORKSPACE_FILE_NOT_FOUND)$/u) });
    expect((await database().query("SELECT 1 FROM family_skills WHERE family_id = $1", [f.familyId])).rowCount).toBe(0);
  });

  it("gives a family skill to an external group only after the owner adds it, with Bash for its scripts", async () => {
    const f = await fixture("5504");
    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз"), "scripts/fetch.py": "print(1)" });
    await stage(f, { path: "skills/weather" });
    await press(f, { action: "activate", name: "weather", version: 1 });
    expect(await resolveConversationSkills(await groupAuth(f))).not.toHaveProperty("weather");

    const status = await manageTelegramGroup.execute({ action: "status" }, ownerContext(f)) as {
      availableSafeSkills: string[]; skillRequirements: Record<string, { tools: string[] }>;
    };
    expect(status.availableSafeSkills).toEqual(expect.arrayContaining(["pdf", "weather"]));
    expect(status.skillRequirements.weather).toEqual({ tools: ["bash"] });

    await expect(manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: ["nope"], telegramChatId: f.groupChatId }, ownerContext(f)))
      .rejects.toMatchObject({ code: "AGENT_GROUP_SKILL_UNKNOWN" });
    const update = { action: "update_skills", skillAllowlist: ["weather", "pdf"], telegramChatId: f.groupChatId };
    const card = await presentTelegramApproval({ ...approvalRequest({}), action: { callId: "call-2", input: update, kind: "tool-call", toolName: "manage_telegram_group" } }, ownerContext(f));
    expect(card.prompt).toContain("Bash");
    await expect(manageTelegramGroup.execute(update as never, ownerContext(f))).resolves.toMatchObject({ automaticallyEnabledTools: ["bash"] });

    const granted = await groupAuth(f);
    expect(granted.current?.attributes.toolAllowlist).toContain("bash");
    expect(Object.keys(await resolveConversationSkills(granted))).toEqual(expect.arrayContaining(["pdf", "weather"]));
    expect(await groupSkillPolicyRepository.loadGroupSkillAllowlist(f.groupId)).toEqual(new Set(["pdf", "weather"]));
  });

  it("closes the grant when the skill is disabled or deleted, leaving the group's other skills", async () => {
    const f = await fixture("5505");
    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз") });
    await stage(f, { path: "skills/weather" });
    await press(f, { action: "activate", name: "weather", version: 1 });
    await manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: ["weather", "pdf"], telegramChatId: f.groupChatId }, ownerContext(f));

    const disabled = await press(f, { action: "disable", name: "weather" });
    expect(disabled).toContain("перестанет работать");
    const group = await groupAuth(f);
    expect(Object.keys(await resolveConversationSkills(group))).toContain("pdf");
    expect(await resolveConversationSkills(group)).not.toHaveProperty("weather");
    expect(await resolveConversationSkills(ownerAuth(f))).not.toHaveProperty("weather");
    expect(await groupSkillPolicyRepository.loadGroupSkillAllowlist(f.groupId)).toEqual(new Set(["pdf"]));

    await press(f, { action: "enable", name: "weather" });
    expect(await resolveConversationSkills(await groupAuth(f))).toHaveProperty("weather");

    await press(f, { action: "delete", name: "weather" });
    expect(await resolveConversationSkills(await groupAuth(f))).not.toHaveProperty("weather");
    expect(await groupSkillPolicyRepository.loadGroupSkillAllowlist(f.groupId)).toEqual(new Set(["pdf"]));
    await expect(manageSkill.execute({ action: "list" }, ownerContext(f))).resolves.toMatchObject({ family: [] });
  });

  it("keeps the family's working skills within what a turn sends to the sandbox", async () => {
    const f = await fixture("5507");
    await seedWorkingSkill(f, "atlas", 8 * 1024 * 1024 - 100);
    await writeFolder(f, "skills/weather", { "SKILL.md": weather("Прогноз"), "data.txt": "x".repeat(1000) });
    await stage(f, { path: "skills/weather" });
    const owner = ownerContext(f);

    await expect(manageSkill.execute({ action: "activate", name: "weather", version: 1 }, owner)).rejects.toMatchObject({
      code: "AGENT_SKILL_FAMILY_LIMIT_REACHED", message: expect.stringContaining("8 МБ"),
    });
    await manageSkill.execute({ action: "disable", name: "atlas" }, owner);
    await expect(manageSkill.execute({ action: "activate", name: "weather", version: 1 }, owner)).resolves.toMatchObject({ status: "active_from_next_turn" });
    await expect(manageSkill.execute({ action: "enable", name: "atlas" }, owner)).rejects.toMatchObject({ code: "AGENT_SKILL_FAMILY_LIMIT_REACHED" });
  });

  it("installs a downloaded skill from the workspace and shows where it came from", async () => {
    const f = await fixture("5506");
    // A clone's history is larger than a skill may be; it is not part of the package.
    await writeFolder(f, "downloads/tides", {
      ".git/config": "[core]\n",
      ".git/objects/pack/history.pack": "x".repeat(3 * 1024 * 1024),
      "README.md": "Таблицы приливов",
      "SKILL.md": "---\nname: tides\ndescription: >-\n  Приливы и отливы\n  по портам\nlicense: MIT\n---\n# Приливы\n",
    });

    const staged = await stage(f, { path: "downloads/tides/", sourceUrl: "https://github.com/example/tides" });
    expect(staged).toMatchObject({ name: "tides", version: 1 });
    const card = await press(f, { action: "activate", name: "tides", version: 1 });
    expect(card).toContain("Источник: скачан с https://github.com/example/tides");
    expect(card).toContain("README.md — 31 Б");
    expect(card).not.toContain(".git");

    const skills = await resolveConversationSkills(ownerAuth(f));
    expect(skills.tides).toMatchObject({ description: "Приливы и отливы по портам", license: "MIT" });
    expect(Object.keys(skills.tides!.files!)).toEqual(["README.md"]);
  });
});
