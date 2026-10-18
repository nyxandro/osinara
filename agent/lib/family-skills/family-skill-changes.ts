/**
 * Changes to the family's skill library, made by its people without confirmation buttons.
 *
 * Exports:
 * - `familySkillChanges`: `save` (a checked package becomes the skill's current version at once; a
 *   new skill is enabled for its author), `rollback`, `setEnabledForSelf`, `setInFamilyGroup`, `remove`.
 * - `FamilySkillActor`.
 *
 * Every change runs in one transaction that rechecks the person is a member of the family — and, for
 * a version, a rollback or a deletion, the skill's author or the family's owner — takes the family's
 * skill lock first so the family's changes run one after another, writes an audit event and enqueues
 * the notices (`family-skill-notices.ts`) under the tool call's operation key.
 */
import type { PoolClient } from "pg";

import { FAMILY_SKILLS_LOCK_HASH_SEED, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../../config.js";
import type { ValidatedSkillPackage } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { pruneOldVersions, requireRoomForNewSkill } from "./family-skill-limits.js";
import { enqueueFamilySkillNotice, type FamilySkillNoticeRecipient } from "./family-skill-notices.js";
import { familySkillNotFound } from "./family-skill-repository.js";

export interface FamilySkillActor {
  readonly familyId: string;
  /** Unique per tool call, so a replayed call neither writes nor notifies twice. */
  readonly operationKey: string;
  readonly userId: string;
}

interface Member {
  readonly displayName: string;
  readonly owner: boolean;
}

interface SkillRow {
  readonly active_version: number | null;
  readonly author_user_id: string | null;
  readonly id: string;
}

interface StoredContent {
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly content: string; readonly executable: boolean; readonly path: string }>;
  readonly license: string | null;
  readonly markdown: string;
}

async function asFamilyMember<T>(actor: FamilySkillActor, work: (client: PoolClient, member: Member) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const member = (await client.query<{ display_name: string; role: string }>(
      `SELECT users.display_name, membership.role FROM family_memberships membership
         JOIN users ON users.id = membership.user_id
        WHERE membership.family_id = $1 AND membership.user_id = $2 FOR SHARE OF membership`,
      [actor.familyId, actor.userId],
    )).rows[0];
    if (member === undefined) throw new AppError("AGENT_ACCESS_DENIED", "Скиллы семьи доступны только членам семьи");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [actor.familyId, FAMILY_SKILLS_LOCK_HASH_SEED]);
    const result = await work(client, { displayName: member.display_name, owner: member.role === "owner" });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockedSkill(client: PoolClient, familyId: string, name: string): Promise<SkillRow | undefined> {
  return (await client.query<SkillRow>(
    "SELECT id, author_user_id, active_version FROM family_skills WHERE family_id = $1 AND name = $2 FOR UPDATE",
    [familyId, name],
  )).rows[0];
}

async function requireSkillEditor(client: PoolClient, actor: FamilySkillActor, member: Member, skill: SkillRow, name: string): Promise<void> {
  if (member.owner || skill.author_user_id === actor.userId) return;
  const author = skill.author_user_id === null ? null : (await client.query<{ display_name: string }>(
    "SELECT display_name FROM users WHERE id = $1", [skill.author_user_id],
  )).rows[0]?.display_name ?? null;
  throw new AppError("AGENT_SKILL_CHANGE_FORBIDDEN",
    `Менять и удалять скилл ${name} может его автор${author === null ? "" : ` (${author})`} или владелец семьи. ` +
    "Можно выключить его у себя или сохранить свою копию под другим именем", { details: { name } });
}

async function enabledUsers(client: PoolClient, skillId: string): Promise<string[]> {
  return (await client.query<{ user_id: string }>(
    "SELECT user_id FROM family_skill_activations WHERE skill_id = $1 ORDER BY user_id", [skillId],
  )).rows.map((row) => row.user_id);
}

/**
 * Who hears of a change to a skill: the person making it, everyone who has it enabled and, when an
 * external group's list holds it, the owner — outsiders get it on the owner's word.
 */
async function concerned(client: PoolClient, actor: FamilySkillActor, skillId: string, name: string): Promise<FamilySkillNoticeRecipient[]> {
  const owners = (await client.query<{ user_id: string }>(
    `SELECT membership.user_id FROM family_memberships membership
      WHERE membership.family_id = $1 AND membership.role = 'owner'
        AND EXISTS (SELECT 1 FROM telegram_groups WHERE family_id = $1 AND type = 'external' AND $2 = ANY(skill_allowlist))`,
    [actor.familyId, name],
  )).rows.map((row) => row.user_id);
  return [actor.userId, ...await enabledUsers(client, skillId), ...owners].map((userId) => ({ userId }));
}

async function audit(client: PoolClient, actor: FamilySkillActor, eventType: string, skillId: string, metadata: object): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [actor.familyId, actor.userId, eventType, skillId, metadata],
  );
}

async function notify(client: PoolClient, actor: FamilySkillActor, recipients: readonly FamilySkillNoticeRecipient[], text: string): Promise<void> {
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const key = "userId" in recipient ? `user:${recipient.userId}` : `group:${recipient.groupId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await enqueueFamilySkillNotice(client, { familyId: actor.familyId, operationKey: `${actor.operationKey}:${key}`, recipient, text });
  }
}

async function storedContent(client: PoolClient, skillId: string, version: number | null): Promise<StoredContent | null> {
  if (version === null) return null;
  return (await client.query<StoredContent>(
    "SELECT description, license, markdown, files FROM family_skill_versions WHERE skill_id = $1 AND version = $2",
    [skillId, version],
  )).rows[0] ?? null;
}

function packageContent(skill: ValidatedSkillPackage): StoredContent {
  return {
    description: skill.description,
    files: skill.files.map((file) => ({ content: Buffer.from(file.content).toString("base64"), executable: file.executable, path: file.path })),
    license: skill.license ?? null,
    markdown: skill.markdown,
  };
}

/** What a person would notice changed between two versions: the instructions and each file. */
function changedParts(before: StoredContent | null, after: StoredContent): { added: string[]; changed: string[]; removed: string[] } {
  const previous = new Map((before?.files ?? []).map((file) => [file.path, file.content]));
  const current = new Map(after.files.map((file) => [file.path, file.content]));
  const instructionsChanged = before === null || before.description !== after.description ||
    before.markdown !== after.markdown || before.license !== after.license;
  return {
    added: [...current.keys()].filter((path) => !previous.has(path)).sort(),
    changed: [
      ...(instructionsChanged ? ["SKILL.md"] : []),
      ...[...current].filter(([path, content]) => previous.has(path) && previous.get(path) !== content).map(([path]) => path).sort(),
    ],
    removed: [...previous.keys()].filter((path) => !current.has(path)).sort(),
  };
}

function sameContent(left: StoredContent | null, right: StoredContent): boolean {
  if (left === null) return false;
  const parts = changedParts(left, right);
  return parts.added.length === 0 && parts.changed.length === 0 && parts.removed.length === 0;
}

function describeParts(parts: ReturnType<typeof changedParts>): string {
  const lines = [
    parts.changed.length > 0 ? `изменены: ${parts.changed.join(", ")}` : null,
    parts.added.length > 0 ? `добавлены: ${parts.added.join(", ")}` : null,
    parts.removed.length > 0 ? `удалены: ${parts.removed.join(", ")}` : null,
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? "содержимое то же" : lines.join("; ");
}

function originLine(origin: { readonly kind: "authored" } | { readonly kind: "downloaded"; readonly url: string }): string {
  return origin.kind === "downloaded" ? `Скачан с ${origin.url} (так сказал агент).` : "Написан агентом.";
}

export const familySkillChanges = {
  async save(input: {
    readonly actor: FamilySkillActor;
    readonly origin: { readonly kind: "authored" } | { readonly kind: "downloaded"; readonly url: string };
    readonly skill: ValidatedSkillPackage;
  }): Promise<{ readonly newSkill: boolean; readonly newVersion: boolean; readonly previousVersion: number | null; readonly version: number }> {
    const { actor, skill } = input;
    return await asFamilyMember(actor, async (client, member) => {
      await requireRoomForNewSkill(client, actor.familyId, skill.name);
      let row = await lockedSkill(client, actor.familyId, skill.name);
      const newSkill = row === undefined;
      if (row === undefined) {
        row = (await client.query<SkillRow>(
          "INSERT INTO family_skills (family_id, name, author_user_id) VALUES ($1, $2, $3) RETURNING id, author_user_id, active_version",
          [actor.familyId, skill.name, actor.userId],
        )).rows[0]!;
      } else {
        await requireSkillEditor(client, actor, member, row, skill.name);
      }
      const content = packageContent(skill);
      const latest = (await client.query<{ version: number }>(
        "SELECT version FROM family_skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE", [row.id],
      )).rows[0];
      const latestContent = await storedContent(client, row.id, latest?.version ?? null);
      const newVersion = !sameContent(latestContent, content);
      const version = newVersion ? (latest?.version ?? 0) + 1 : latest!.version;
      if (newVersion) {
        await client.query(
          `INSERT INTO family_skill_versions
             (skill_id, version, description, license, markdown, files, content_hash, origin_kind, origin_url, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
          [
            row.id, version, content.description, content.license, content.markdown,
            JSON.stringify(skill.files.map((file) => ({
              content: Buffer.from(file.content).toString("base64"), executable: file.executable, path: file.path, size: file.size,
            }))),
            skill.contentHash, input.origin.kind, input.origin.kind === "downloaded" ? input.origin.url : null, actor.userId,
          ],
        );
      }
      const previousVersion = row.active_version;
      if (previousVersion === version) return { newSkill, newVersion, previousVersion, version };
      const before = await storedContent(client, row.id, previousVersion);
      await client.query("UPDATE family_skills SET active_version = $2, updated_at = now() WHERE id = $1", [row.id, version]);
      await pruneOldVersions(client, row.id);
      // A new skill, or one stored before versions became current on save, starts enabled for its saver.
      if (newSkill || previousVersion === null) {
        await client.query("INSERT INTO family_skill_activations (skill_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [row.id, actor.userId]);
      }
      await audit(client, actor, "family_skill.saved", row.id, { name: skill.name, origin: input.origin.kind, previousVersion, version });
      const files = skill.files.map((file) => `${file.path}${file.executable ? " (скрипт)" : ""}`);
      const text = newSkill
        ? [
          `Скилл «${skill.name}» сохранён в библиотеку семьи и включён у тебя со следующего сообщения.`,
          `Описание: ${skill.description}`,
          `Файлы: SKILL.md${files.length > 0 ? `, ${files.join(", ")}` : ""}.`,
          originLine(input.origin),
          "Другие члены семьи могут включить его себе. Выключить или удалить — скажи агенту.",
        ].join("\n")
        : [
          `Скилл «${skill.name}» теперь работает в версии ${version}${previousVersion === null ? "" : ` вместо ${previousVersion}`} (изменил: ${member.displayName}).`,
          `Что поменялось: ${describeParts(changedParts(before, content))}.`,
          ...(newVersion ? [originLine(input.origin)] : []),
          `Вернуть прежнюю версию: «откати ${skill.name}».`,
        ].join("\n");
      await notify(client, actor, await concerned(client, actor, row.id, skill.name), text);
      return { newSkill, newVersion, previousVersion, version };
    });
  },

  async rollback(input: { readonly actor: FamilySkillActor; readonly name: string; readonly version: number }): Promise<{ readonly previousVersion: number | null }> {
    const { actor, name, version } = input;
    return await asFamilyMember(actor, async (client, member) => {
      const skill = await lockedSkill(client, actor.familyId, name);
      if (skill === undefined) throw familySkillNotFound(name);
      await requireSkillEditor(client, actor, member, skill, name);
      const target = await storedContent(client, skill.id, version);
      if (target === null) {
        throw new AppError("AGENT_SKILL_VERSION_NOT_FOUND", `У скилла ${name} нет версии ${version}. Посмотрите версии через view`, { details: { name, version } });
      }
      if (skill.active_version === version) return { previousVersion: version };
      const before = await storedContent(client, skill.id, skill.active_version);
      await client.query("UPDATE family_skills SET active_version = $2, updated_at = now() WHERE id = $1", [skill.id, version]);
      await audit(client, actor, "family_skill.rolled_back", skill.id, { name, previousVersion: skill.active_version, version });
      await notify(client, actor, await concerned(client, actor, skill.id, name), [
        `Скилл «${name}» возвращён к версии ${version}${skill.active_version === null ? "" : ` вместо ${skill.active_version}`} (изменил: ${member.displayName}).`,
        `Что поменялось: ${describeParts(changedParts(before, target))}.`,
      ].join("\n"));
      return { previousVersion: skill.active_version };
    });
  },

  async setEnabledForSelf(input: { readonly actor: FamilySkillActor; readonly enabled: boolean; readonly name: string }): Promise<{ readonly changed: boolean }> {
    const { actor, enabled, name } = input;
    return await asFamilyMember(actor, async (client) => {
      const skill = await lockedSkill(client, actor.familyId, name);
      if (skill === undefined) throw familySkillNotFound(name);
      if (enabled && skill.active_version === null) {
        throw new AppError("AGENT_SKILL_NOT_SAVED", `У скилла ${name} нет рабочей версии: сначала сохраните его через save`, { details: { name } });
      }
      const result = enabled
        ? await client.query("INSERT INTO family_skill_activations (skill_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [skill.id, actor.userId])
        : await client.query("DELETE FROM family_skill_activations WHERE skill_id = $1 AND user_id = $2", [skill.id, actor.userId]);
      if (result.rowCount !== 1) return { changed: false };
      await audit(client, actor, enabled ? "family_skill.enabled_for_self" : "family_skill.disabled_for_self", skill.id, { name });
      await notify(client, actor, [{ userId: actor.userId }],
        enabled ? `Скилл «${name}» включён у тебя со следующего сообщения.` : `Скилл «${name}» выключен у тебя со следующего сообщения.`);
      return { changed: true };
    });
  },

  async setInFamilyGroup(input: {
    readonly actor: FamilySkillActor; readonly enabled: boolean; readonly name: string; readonly telegramChatId: string;
  }): Promise<{ readonly changed: boolean; readonly title: string }> {
    const { actor, enabled, name } = input;
    return await asFamilyMember(actor, async (client, member) => {
      const skill = await lockedSkill(client, actor.familyId, name);
      if (skill === undefined) throw familySkillNotFound(name);
      if (enabled && skill.active_version === null) {
        throw new AppError("AGENT_SKILL_NOT_SAVED", `У скилла ${name} нет рабочей версии: сначала сохраните его через save`, { details: { name } });
      }
      // The same chat lock as group registration: a group being re-registered is not edited meanwhile.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED]);
      const group = (await client.query<{ id: string; skill_allowlist: string[]; title: string }>(
        `SELECT id, title, skill_allowlist FROM telegram_groups
          WHERE family_id = $1 AND telegram_chat_id = $2 AND type = 'family_private' FOR UPDATE`,
        [actor.familyId, input.telegramChatId],
      )).rows[0];
      if (group === undefined) {
        throw new AppError("AGENT_FAMILY_GROUP_NOT_FOUND", "Такого семейного чата нет. Список семейных чатов показывает manage_skill list", {
          details: { telegramChatId: input.telegramChatId },
        });
      }
      const listed = group.skill_allowlist.includes(name);
      if (listed === enabled) return { changed: false, title: group.title };
      const skills = enabled ? [...group.skill_allowlist, name] : group.skill_allowlist.filter((item) => item !== name);
      await client.query("UPDATE telegram_groups SET skill_allowlist = $2 WHERE id = $1", [group.id, skills]);
      await audit(client, actor, enabled ? "family_skill.family_group_enabled" : "family_skill.family_group_disabled", skill.id, { groupId: group.id, name });
      await notify(client, actor, [{ groupId: group.id }], enabled
        ? `В этом чате включён скилл «${name}» (включил: ${member.displayName}). Он работает у всех, кто пишет здесь.`
        : `В этом чате выключен скилл «${name}» (выключил: ${member.displayName}).`);
      return { changed: true, title: group.title };
    });
  },

  async remove(input: { readonly actor: FamilySkillActor; readonly name: string }): Promise<void> {
    const { actor, name } = input;
    await asFamilyMember(actor, async (client, member) => {
      const skill = await lockedSkill(client, actor.familyId, name);
      if (skill === undefined) throw familySkillNotFound(name);
      await requireSkillEditor(client, actor, member, skill, name);
      const recipients = await concerned(client, actor, skill.id, name);
      await client.query("DELETE FROM family_skills WHERE id = $1", [skill.id]);
      // A later skill under the same name must not be granted by an old list entry.
      await client.query(
        `UPDATE telegram_groups SET skill_allowlist = array_remove(skill_allowlist, $2)
          WHERE family_id = $1 AND $2 = ANY(skill_allowlist)`,
        [actor.familyId, name],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata) VALUES ($1, $2, 'family_skill.deleted', $3)`,
        [actor.familyId, actor.userId, { name }],
      );
      await notify(client, actor, recipients, `Скилл «${name}» удалён из библиотеки семьи (удалил: ${member.displayName}).`);
    });
  },
};
