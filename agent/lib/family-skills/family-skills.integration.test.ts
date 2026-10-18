/**
 * The family's skill library from a member's request to the turns that receive it.
 *
 * Constructs covered:
 * - A saved skill works at once for its author only; any other member enables it for themselves.
 * - A new version replaces the current one for everyone who has it, a rollback brings one back, and
 *   each change leaves notices that say what changed; only the author or the owner changes a skill.
 * - A family chat has every built-in skill and the family skills on its list, which any member
 *   changes; an external group gets a family skill only from the owner, a script skill only with Bash.
 * - Broken packages, taken names, missing folders and a skill pointing at its draft are refused; a
 *   checkout writes the current version back into the draft folder; versions are pruned.
 */
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import type { ToolContext } from "../../runtime/tool.js";
import { closeDatabase, database } from "../database.js";
import { groupSkillPolicyRepository } from "../group-skills/group-skill-repository.js";
import { resolveConversationSkills } from "../group-skills/group-skill-resolver.js";
import { withGroupSandboxAccess } from "../sandbox-runner/group-sandbox-policy.js";
import manageSkill from "../tools/manage_skill.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { WORKSPACES_ROOT } from "../workspaces/workspace-repository.js";
import {
  deleteWorkspaceDirectory,
  listWorkspaceStoredFilesUnder,
  readWorkspaceFile,
  workspaceDirectory,
  writeWorkspaceFile,
} from "../workspaces/workspace-storage.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Person {
  readonly id: string;
  readonly role: "member" | "owner";
  readonly telegramId: string;
}

interface Fixture {
  readonly familyGroupChatId: string;
  readonly familyGroupId: string;
  readonly familyId: string;
  readonly groupChatId: string;
  readonly groupId: string;
  readonly member: Person;
  readonly owner: Person;
}

const workspaces = new Set<string>();
let calls = 0;

async function person(familyId: string, telegramId: string, name: string, role: Person["role"]): Promise<Person> {
  const user = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id", [telegramId, name],
  )).rows[0]!;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, $3)", [familyId, user.id, role]);
  return { id: user.id, role, telegramId };
}

async function fixture(suffix: string): Promise<Fixture> {
  const family = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Skills ${suffix}`])).rows[0]!;
  const owner = await person(family.id, `77${suffix}`, `Owner ${suffix}`, "owner");
  const member = await person(family.id, `88${suffix}`, `Dina ${suffix}`, "member");
  const group = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, $2, $3, 'external', 'addressed_only', '{}') RETURNING id`,
    [family.id, `-100${suffix}`, `Group ${suffix}`],
  )).rows[0]!;
  const familyGroup = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, $2, $3, 'family_private', 'all', '{}') RETURNING id`,
    [family.id, `-200${suffix}`, `Family ${suffix}`],
  )).rows[0]!;
  return {
    familyGroupChatId: `-200${suffix}`, familyGroupId: familyGroup.id, familyId: family.id,
    groupChatId: `-100${suffix}`, groupId: group.id, member, owner,
  };
}

function privateAuth(f: Fixture, who: Person): SessionAuth {
  const caller = {
    attributes: {
      familyId: f.familyId, memoryScopes: ["personal", "family"], role: who.role,
      telegramActorId: who.telegramId, telegramActorKind: "telegram_user", telegramChatId: who.telegramId,
      telegramChatType: "private", telegramUserId: who.telegramId,
    },
    authenticator: "telegram", principalId: who.id, principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

function familyGroupAuth(f: Fixture, who: Person): SessionAuth {
  const caller = {
    attributes: {
      familyId: f.familyId, groupId: f.familyGroupId, groupType: "family_private", memoryScopes: ["family"], role: who.role,
      telegramActorId: who.telegramId, telegramActorKind: "telegram_user", telegramChatId: f.familyGroupChatId,
      telegramChatType: "supergroup", telegramUserId: who.telegramId,
    },
    authenticator: "telegram", principalId: who.id, principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

/** The external group's turn as its verified snapshot carries the current lists. */
async function groupAuth(f: Fixture): Promise<SessionAuth> {
  const row = (await database().query<{ skill_allowlist: string[]; tool_allowlist: string[] }>(
    "SELECT skill_allowlist, tool_allowlist FROM telegram_groups WHERE id = $1", [f.groupId],
  )).rows[0]!;
  const caller = {
    attributes: {
      familyId: f.familyId, groupId: f.groupId, groupType: "external", memoryScopes: ["group"], role: "member",
      skillAllowlist: row.skill_allowlist, telegramActorId: f.owner.telegramId, telegramActorKind: "telegram_user",
      telegramChatType: "supergroup", telegramUserId: f.owner.telegramId, toolAllowlist: row.tool_allowlist,
    },
    authenticator: "telegram", principalId: f.owner.id, principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

/** A tool call's context: every call has its own id, as in a real turn. */
function context(auth: SessionAuth): ToolContext {
  calls += 1;
  return { callId: `call-${calls}`, session: { auth, id: `session-${auth.current!.principalId}`, turn: { id: "turn-test", sequence: 0 } } } as unknown as ToolContext;
}

async function writeFolder(f: Fixture, who: Person, folder: string, files: Readonly<Record<string, string>>): Promise<string> {
  const workspaceId = await workspaceBinaryRepository.workspaceId(requireWorkspaceAuthorization(context(privateAuth(f, who))), "personal");
  workspaces.add(workspaceId);
  for (const [path, content] of Object.entries(files)) {
    await writeWorkspaceFile(WORKSPACES_ROOT, workspaceId, `${folder}/${path}`, Buffer.from(content, "utf8"));
  }
  return workspaceId;
}

async function run(f: Fixture, who: Person, input: Record<string, unknown>) {
  return await manageSkill.execute(input as never, context(privateAuth(f, who))) as Record<string, unknown>;
}

async function save(f: Fixture, who: Person, input: Record<string, string>) {
  return await run(f, who, { action: "save", scope: "personal", ...input });
}

async function notices(recipient: { userId: string } | { groupId: string }): Promise<string[]> {
  return (await database().query<{ text: string }>(
    `SELECT text FROM family_skill_notices WHERE ${"userId" in recipient ? "recipient_user_id" : "recipient_group_id"} = $1 ORDER BY created_at, id`,
    ["userId" in recipient ? recipient.userId : recipient.groupId],
  )).rows.map((row) => row.text);
}

const weather = (description: string) => `---\nname: weather\ndescription: ${description}\n---\n# Погода\nЗапусти $HOME/.agents/skills/weather/scripts/fetch.py.\n`;

describeWithDatabase("family skill library", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE family_skills, family_skill_notices, workspaces, telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => {
    for (const id of workspaces) await deleteWorkspaceDirectory(WORKSPACES_ROOT, id);
    await closeDatabase();
  });

  it("works at once for its author only; any other member enables it for themselves", async () => {
    const f = await fixture("5501");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз погоды по городу"), "scripts/fetch.py": "print(1)" });

    await expect(save(f, f.owner, { path: "skills/weather" })).resolves.toMatchObject({ name: "weather", status: "saved_and_enabled_for_you", version: 1 });
    const own = await resolveConversationSkills(privateAuth(f, f.owner));
    expect(own.weather).toMatchObject({ description: "Прогноз погоды по городу" });
    expect(Buffer.from(own.weather!.files!["scripts/fetch.py"] as Uint8Array).toString("utf8")).toBe("print(1)");
    expect(own).toHaveProperty("pdf");
    expect(own).toHaveProperty("skill-manager");
    expect(await resolveConversationSkills(privateAuth(f, f.member))).not.toHaveProperty("weather");

    await expect(run(f, f.member, { action: "enable", name: "weather", target: "me" })).resolves.toMatchObject({ changed: true });
    await expect(run(f, f.member, { action: "enable", name: "weather", target: "me" })).resolves.toMatchObject({ changed: false });
    expect(await resolveConversationSkills(privateAuth(f, f.member))).toHaveProperty("weather");
    await run(f, f.member, { action: "disable", name: "weather", target: "me" });
    expect(await resolveConversationSkills(privateAuth(f, f.member))).not.toHaveProperty("weather");

    const [saved] = await notices({ userId: f.owner.id });
    expect(saved).toContain("Скилл «weather» сохранён в библиотеку семьи и включён у тебя");
    expect(saved).toContain("scripts/fetch.py (скрипт)");
    expect(saved).toContain("Написан агентом.");
    expect(await notices({ userId: f.member.id })).toEqual([
      "Скилл «weather» включён у тебя со следующего сообщения.",
      "Скилл «weather» выключен у тебя со следующего сообщения.",
    ]);
  });

  it("replaces the current version for everyone who has it, says what changed, and rolls back", async () => {
    const f = await fixture("5502");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз v1"), "scripts/fetch.py": "print(1)" });
    await save(f, f.owner, { path: "skills/weather" });
    await run(f, f.member, { action: "enable", name: "weather", target: "me" });

    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз v2"), "data.txt": "x" });
    await expect(save(f, f.owner, { path: "skills/weather" })).resolves.toMatchObject({ status: "current_version_replaced", version: 2, previousVersion: 1 });
    await expect(save(f, f.owner, { path: "skills/weather" })).resolves.toMatchObject({ status: "unchanged", version: 2 });
    expect((await resolveConversationSkills(privateAuth(f, f.member))).weather?.description).toBe("Прогноз v2");
    const update = (await notices({ userId: f.member.id })).at(-1)!;
    expect(update).toContain("Скилл «weather» теперь работает в версии 2 вместо 1 (изменил: Owner 5502).");
    expect(update).toContain("изменены: SKILL.md; добавлены: data.txt");

    await expect(run(f, f.owner, { action: "rollback", name: "weather", version: 1 })).resolves.toMatchObject({ previousVersion: 2 });
    expect((await resolveConversationSkills(privateAuth(f, f.member))).weather?.description).toBe("Прогноз v1");
    expect((await notices({ userId: f.member.id })).at(-1)).toContain("возвращён к версии 1 вместо 2");
  });

  it("lets only the author or the owner change or delete a skill", async () => {
    const f = await fixture("5503");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз") });
    await save(f, f.owner, { path: "skills/weather" });
    await writeFolder(f, f.member, "skills/weather", { "SKILL.md": weather("Мой прогноз") });

    await expect(save(f, f.member, { path: "skills/weather" })).rejects.toMatchObject({
      code: "AGENT_SKILL_CHANGE_FORBIDDEN", message: expect.stringContaining("(Owner 5503)"),
    });
    await expect(run(f, f.member, { action: "rollback", name: "weather", version: 1 })).rejects.toMatchObject({ code: "AGENT_SKILL_CHANGE_FORBIDDEN" });
    await expect(run(f, f.member, { action: "delete", name: "weather" })).rejects.toMatchObject({ code: "AGENT_SKILL_CHANGE_FORBIDDEN" });

    await writeFolder(f, f.member, "skills/tides", { "SKILL.md": "---\nname: tides\ndescription: Приливы\n---\nТекст\n" });
    await save(f, f.member, { path: "skills/tides" });
    expect(await resolveConversationSkills(privateAuth(f, f.owner))).not.toHaveProperty("tides");
    // Outsiders get a skill on the owner's word, so the owner hears when its author changes it.
    await manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: ["tides"], telegramChatId: f.groupChatId } as never,
      context(privateAuth(f, f.owner)));
    await writeFolder(f, f.member, "skills/tides", { "SKILL.md": "---\nname: tides\ndescription: Приливы v2\n---\nТекст\n" });
    await save(f, f.member, { path: "skills/tides" });
    expect((await notices({ userId: f.owner.id })).at(-1)).toContain("Скилл «tides» теперь работает в версии 2 вместо 1 (изменил: Dina 5503).");
    await run(f, f.owner, { action: "delete", name: "tides" });
    expect((await notices({ userId: f.member.id })).at(-1)).toBe("Скилл «tides» удалён из библиотеки семьи (удалил: Owner 5503).");
    await expect(run(f, f.member, { action: "list" })).resolves.toMatchObject({ family: [{ name: "weather", author: "Owner 5503", enabledForMe: false }] });
  });

  it("refuses a broken package, a taken name, a missing folder and a skill that runs from its draft", async () => {
    const f = await fixture("5504");
    await writeFolder(f, f.owner, "skills/broken", { "SKILL.md": "---\nname: broken\n---\nТекст\n" });
    await writeFolder(f, f.owner, "skills/pdf", { "SKILL.md": "---\nname: pdf\ndescription: Свой PDF\n---\nТекст\n" });
    await writeFolder(f, f.owner, "skills/skill-manager", { "SKILL.md": "---\nname: skill-manager\ndescription: Свой\n---\nТекст\n" });
    await writeFolder(f, f.owner, "skills/draft", { "SKILL.md": "---\nname: draft\ndescription: Черновик\n---\npython3 skills/draft/run.py\n" });

    await expect(save(f, f.owner, { path: "skills/broken" })).rejects.toMatchObject({
      code: "AGENT_SKILL_PACKAGE_INVALID", message: expect.stringContaining("нет описания"),
    });
    await expect(save(f, f.owner, { path: "skills/pdf" })).rejects.toMatchObject({ code: "AGENT_SKILL_NAME_TAKEN" });
    await expect(save(f, f.owner, { path: "skills/skill-manager" })).rejects.toMatchObject({ code: "AGENT_SKILL_NAME_TAKEN" });
    await expect(save(f, f.owner, { path: "skills/draft" })).rejects.toMatchObject({ code: "AGENT_SKILL_DRAFT_PATH_REFERENCE" });
    await expect(save(f, f.owner, { path: "skills/none" })).rejects.toMatchObject({ code: expect.stringMatching(/^AGENT_(SKILL_PACKAGE_INVALID|WORKSPACE_FILE_NOT_FOUND)$/u) });
    await expect(run(f, f.owner, { action: "enable", name: "pdf", target: "me" })).rejects.toMatchObject({ code: "AGENT_SKILL_BUILT_IN" });
    expect((await database().query("SELECT 1 FROM family_skills WHERE family_id = $1", [f.familyId])).rowCount).toBe(0);
  });

  it("gives a family chat every built-in skill and the family skills any member puts on its list", async () => {
    const f = await fixture("5505");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз") });
    await save(f, f.owner, { path: "skills/weather" });
    const inChat = await resolveConversationSkills(familyGroupAuth(f, f.member));
    expect(inChat).toHaveProperty("pdf");
    expect(inChat).not.toHaveProperty("weather");
    expect(inChat).not.toHaveProperty("skill-manager");

    await expect(run(f, f.member, { action: "list" })).resolves.toMatchObject({ familyGroups: [{ group: f.familyGroupChatId, title: "Family 5505" }] });
    await run(f, f.member, { action: "enable", name: "weather", target: "family_group", group: f.familyGroupChatId });
    expect(await resolveConversationSkills(familyGroupAuth(f, f.owner))).toHaveProperty("weather");
    expect(await notices({ groupId: f.familyGroupId })).toEqual([
      "В этом чате включён скилл «weather» (включил: Dina 5505). Он работает у всех, кто пишет здесь.",
    ]);
    const status = await manageTelegramGroup.execute({ action: "status" }, context(privateAuth(f, f.owner))) as {
      groups: Array<{ effectiveSkills: string[]; type: string }>;
    };
    expect(status.groups.find((group) => group.type === "family_private")?.effectiveSkills).toContain("weather");

    await run(f, f.owner, { action: "disable", name: "weather", target: "family_group", group: f.familyGroupChatId });
    expect(await resolveConversationSkills(familyGroupAuth(f, f.owner))).not.toHaveProperty("weather");
    await expect(run(f, f.member, { action: "enable", name: "weather", target: "family_group", group: f.groupChatId }))
      .rejects.toMatchObject({ code: "AGENT_FAMILY_GROUP_NOT_FOUND" });
    await expect(manageSkill.execute({ action: "list" } as never, context(familyGroupAuth(f, f.owner))))
      .rejects.toMatchObject({ code: "AGENT_PRIVATE_CHAT_REQUIRED" });
  });

  it("gives an external group a family skill only from the owner, and a script skill only with Bash", async () => {
    const f = await fixture("5506");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз"), "scripts/fetch.py": "print(1)" });
    await save(f, f.owner, { path: "skills/weather" });
    const owner = () => context(privateAuth(f, f.owner));
    const update = (skillAllowlist: string[]) => manageTelegramGroup.execute(
      { action: "update_skills", skillAllowlist, telegramChatId: f.groupChatId } as never, owner(),
    );

    expect(manageTelegramGroup.approval?.({ toolInput: { action: "update_skills", skillAllowlist: [], telegramChatId: f.groupChatId } } as never)).toBe("not-applicable");
    expect(manageTelegramGroup.approval?.({ toolInput: { action: "update_policy", messageMode: "all", telegramChatId: f.groupChatId, toolAllowlist: [] } } as never)).toBe("user-approval");
    await expect(update(["weather", "pdf"])).rejects.toMatchObject({ code: "AGENT_GROUP_SKILL_NEEDS_BASH" });
    await expect(update(["behavior-preferences"])).resolves.toMatchObject({ skillsUpdated: true });
    expect((await notices({ userId: f.owner.id })).at(-1)).toBe(`Скиллы группы «Group 5506» теперь: behavior-preferences.`);

    // What the owner's button runs after the rights card.
    await manageTelegramGroup.execute({ action: "update_policy", messageMode: "all", telegramChatId: f.groupChatId, toolAllowlist: ["bash"] } as never, owner());
    await update(["weather", "pdf"]);
    expect(Object.keys(await resolveConversationSkills(await groupAuth(f)))).toEqual(["weather", "pdf"]);
    expect(await groupSkillPolicyRepository.loadGroupSkillAllowlist(f.groupId)).toEqual(new Set(["pdf", "weather"]));
    await expect(manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: [], telegramChatId: f.groupChatId } as never,
      context(privateAuth(f, f.member)))).rejects.toMatchObject({ code: "AGENT_OWNER_REQUIRED" });
    // Without a button, neither a schedule nor a delegated task changes what outsiders get.
    const ownerAuth = privateAuth(f, f.owner);
    const scheduled = { ...ownerAuth.current!, attributes: { ...ownerAuth.current!.attributes, scheduledRunId: "run-1" } };
    await expect(manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: [], telegramChatId: f.groupChatId } as never,
      context({ current: scheduled, initiator: scheduled } as SessionAuth))).rejects.toMatchObject({ code: "AGENT_GROUP_SKILLS_CONVERSATION_REQUIRED" });
    const delegated = { ...context(ownerAuth), session: { ...context(ownerAuth).session, parent: { callId: "c", rootSessionId: "s", sessionId: "s", turn: { id: "t", sequence: 0 } } } };
    await expect(manageTelegramGroup.execute({ action: "update_skills", skillAllowlist: [], telegramChatId: f.groupChatId } as never,
      delegated as ToolContext)).rejects.toMatchObject({ code: "AGENT_GROUP_SKILLS_CONVERSATION_REQUIRED" });
    expect(await groupSkillPolicyRepository.loadGroupSkillAllowlist(f.groupId)).toEqual(new Set(["pdf", "weather"]));

    // Deleting the skill takes it off the group's list: a later skill under the same name is not granted.
    await run(f, f.owner, { action: "delete", name: "weather" });
    expect((await groupAuth(f)).current?.attributes.skillAllowlist).toEqual(["pdf"]);
    const workspaceId = await workspaceBinaryRepository.workspaceId(requireWorkspaceAuthorization(context(await groupAuth(f))), "group");
    await expect(withGroupSandboxAccess(workspaceId, async () => "synced", undefined, ["weather"]))
      .rejects.toMatchObject({ code: "AGENT_GROUP_SKILL_FORBIDDEN" });
  });

  it("enables a skill stored before versions became current for whoever saves it now", async () => {
    const f = await fixture("5513");
    const skill = (await database().query<{ id: string }>(
      "INSERT INTO family_skills (family_id, name, author_user_id) VALUES ($1, 'weather', $2) RETURNING id", [f.familyId, f.member.id],
    )).rows[0]!;
    await database().query(
      `INSERT INTO family_skill_versions (skill_id, version, description, markdown, files, content_hash, origin_kind, created_by)
       VALUES ($1, 1, 'Старый', 'Текст', '[]'::jsonb, repeat('a', 64), 'authored', $2)`, [skill.id, f.member.id],
    );
    await writeFolder(f, f.member, "skills/weather", { "SKILL.md": weather("Прогноз") });

    await expect(save(f, f.member, { path: "skills/weather" })).resolves.toMatchObject({ status: "current_version_replaced", version: 2 });
    expect(await resolveConversationSkills(privateAuth(f, f.member))).toHaveProperty("weather");
  });

  it("changes nothing for a person who left the family, even from an old session", async () => {
    const f = await fixture("5507");
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз") });
    await save(f, f.owner, { path: "skills/weather" });
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [f.member.id]);

    await expect(run(f, f.member, { action: "enable", name: "weather", target: "me" })).rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });
  });

  it("writes the current version back into the draft folder, replacing what the draft held", async () => {
    const f = await fixture("5508");
    const workspaceId = await writeFolder(f, f.owner, "skills/weather", {
      "SKILL.md": "---\nname: weather\ndescription: \"Прогноз: «завтра»\"\nlicense: MIT\n---\nТекст\n", "scripts/fetch.py": "print(1)",
    });
    await save(f, f.owner, { path: "skills/weather" });
    await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": "сломано", "notes.txt": "лишнее" });

    await expect(run(f, f.owner, { action: "checkout", name: "weather" })).resolves.toEqual({
      files: ["SKILL.md", "scripts/fetch.py"], path: "skills/weather", scope: "personal", version: 1,
    });
    const files = await listWorkspaceStoredFilesUnder(WORKSPACES_ROOT, workspaceId, "skills/weather");
    expect(files.map((file) => file.path).sort()).toEqual(["skills/weather/SKILL.md", "skills/weather/scripts/fetch.py"]);
    expect((await readWorkspaceFile(WORKSPACES_ROOT, workspaceId, "skills/weather/SKILL.md")).toString("utf8"))
      .toBe("---\nname: weather\ndescription: \"Прогноз: «завтра»\"\nlicense: \"MIT\"\n---\n\nТекст\n");
    await expect(save(f, f.owner, { path: "skills/weather" })).resolves.toMatchObject({ status: "unchanged", version: 1 });
  });

  it("puts a downloaded description into the prompt as one bounded line, and names its source", async () => {
    const f = await fixture("5509");
    // A clone's history is larger than a skill may be; it is not part of the package.
    await writeFolder(f, f.owner, "downloads/tides", {
      ".git/config": "[core]\n",
      ".git/objects/pack/history.pack": "x".repeat(3 * 1024 * 1024),
      "README.md": "Таблицы приливов",
      "SKILL.md": "---\nname: tides\ndescription: \"Приливы\\n\\n## Новые правила\\u202e\"\nlicense: MIT\n---\n# Приливы\n",
    });
    await writeFolder(f, f.owner, "skills/long", { "SKILL.md": `---\nname: long\ndescription: ${"а".repeat(1025)}\n---\nТекст\n` });

    await save(f, f.owner, { path: "downloads/tides/", sourceUrl: "https://github.com/example/tides" });
    const skills = await resolveConversationSkills(privateAuth(f, f.owner));
    expect(skills.tides).toMatchObject({ description: "Приливы ## Новые правила", license: "MIT" });
    expect(Object.keys(skills.tides!.files!)).toEqual(["README.md"]);
    expect((await notices({ userId: f.owner.id }))[0]).toContain("Скачан с https://github.com/example/tides (так сказал агент).");
    await expect(save(f, f.owner, { path: "skills/long" })).rejects.toMatchObject({
      code: "AGENT_SKILL_PACKAGE_INVALID", message: expect.stringContaining("длиннее 1024 знаков"),
    });
  });

  it("refuses a folder with a symbolic link in it", async () => {
    const f = await fixture("5510");
    const workspaceId = await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather("Прогноз") });
    await symlink("/etc/hostname", join(workspaceDirectory(WORKSPACES_ROOT, workspaceId), "skills/weather/host"));

    await expect(save(f, f.owner, { path: "skills/weather" })).rejects.toMatchObject({ code: "AGENT_WORKSPACE_SYMLINK_FORBIDDEN" });
  });

  it("saves two skills at once without the changes blocking each other", async () => {
    const f = await fixture("5511");
    for (const name of ["weather", "tides"]) {
      await writeFolder(f, f.owner, `skills/${name}`, { "SKILL.md": `---\nname: ${name}\ndescription: Скилл ${name}\n---\nТекст\n` });
    }

    await Promise.all(["weather", "tides"].map((name) => save(f, f.owner, { path: `skills/${name}` })));
    expect(Object.keys(await resolveConversationSkills(privateAuth(f, f.owner)))).toEqual(expect.arrayContaining(["tides", "weather"]));
  });

  it("keeps the newest versions, and a rollback keeps them all", async () => {
    const f = await fixture("5512");
    for (let version = 1; version <= 7; version += 1) {
      await writeFolder(f, f.owner, "skills/weather", { "SKILL.md": weather(`Прогноз v${version}`) });
      await save(f, f.owner, { path: "skills/weather" });
    }
    const versions = async () => ((await run(f, f.owner, { action: "view", name: "weather" })) as { versions: Array<{ version: number }> })
      .versions.map(({ version }) => version);
    expect(await versions()).toEqual([7, 6, 5, 4, 3]);

    await run(f, f.owner, { action: "rollback", name: "weather", version: 3 });
    expect(await versions()).toEqual([7, 6, 5, 4, 3]);
    expect((await resolveConversationSkills(privateAuth(f, f.owner))).weather?.description).toBe("Прогноз v3");
  });
});
