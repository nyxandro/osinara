/**
 * A family's own skills in PostgreSQL: versions wait for the owner's button, one version works.
 *
 * Exports:
 * - `familySkillRepository`: the working skills a turn receives; the owner's list and details;
 *   storing a checked package as a new version; and the changes the owner confirms — making a
 *   version the working one (create, update, rollback), enabling, disabling, deleting.
 * - `grantableFamilySkills`: the skills the owner has confirmed at least once (a group's list may
 *   name them), whether each is enabled and whether its working version runs scripts; read inside
 *   the caller's transaction.
 * - `FamilySkillSummary`, `FamilySkillVersion`, `StoredSkillFile`.
 *
 * A new version is only stored: the skill keeps working with its current version until the owner
 * confirms the new one; the newest versions stay for a rollback (`family-skill-limits.ts`). Every
 * change re-checks in the same transaction that the person is still the family's owner — a button
 * pressed after the role was taken away changes nothing — and takes the family's skill lock first,
 * so changes of one family run one after another. Deleting a skill also takes it off the skill
 * lists of the family's groups: a later skill under the same name is not granted by the old entry.
 */
import type { Pool, PoolClient } from "pg";

import { FAMILY_SKILLS_LOCK_HASH_SEED } from "../../config.js";
import type { SkillDefinition } from "../../runtime/skills/definition.js";
import type { ValidatedSkillPackage } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { pruneOldVersions, requireRoomForNewSkill, requireWorkingSizeWithin } from "./family-skill-limits.js";

export interface StoredSkillFile {
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

export interface FamilySkillVersion {
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly description: string;
  readonly files: readonly StoredSkillFile[];
  /** Bytes of the `SKILL.md` instructions after the header. */
  readonly markdownSize: number;
  readonly origin: { readonly kind: "authored" } | { readonly kind: "downloaded"; readonly url: string };
  readonly version: number;
}

export interface FamilySkillSummary {
  readonly activeVersion: number | null;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly latestVersion: number;
  readonly name: string;
}

interface VersionRow {
  content_hash: string;
  created_at: Date;
  description: string;
  files: Array<StoredSkillFile & { content: string }>;
  markdown_size: number;
  origin_kind: "authored" | "downloaded";
  origin_url: string | null;
  version: number;
}

function toVersion(row: VersionRow): FamilySkillVersion {
  return {
    contentHash: row.content_hash,
    createdAt: row.created_at,
    description: row.description,
    files: row.files.map(({ executable, path, size }) => ({ executable, path, size })),
    markdownSize: row.markdown_size,
    origin: row.origin_kind === "downloaded" ? { kind: "downloaded", url: row.origin_url! } : { kind: "authored" },
    version: row.version,
  };
}

function notFound(name: string): AppError {
  return new AppError("AGENT_SKILL_NOT_FOUND", `Скилл ${name} не найден среди скиллов семьи`, { details: { name } });
}

async function asCurrentOwner<T>(familyId: string, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE",
      [familyId, userId],
    );
    if (owner.rowCount !== 1) throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [familyId, FAMILY_SKILLS_LOCK_HASH_SEED]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function grantableFamilySkills(
  queryable: Pick<Pool | PoolClient, "query">,
  familyId: string,
): Promise<Map<string, { readonly enabled: boolean; readonly executable: boolean }>> {
  const rows = (await queryable.query<{ enabled: boolean; executable: boolean; name: string }>(
    `SELECT skill.name, skill.enabled,
            EXISTS (SELECT 1 FROM jsonb_array_elements(version.files) file WHERE (file->>'executable')::boolean) AS executable
       FROM family_skills skill
       JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
      WHERE skill.family_id = $1`,
    [familyId],
  )).rows;
  return new Map(rows.map((row) => [row.name, { enabled: row.enabled, executable: row.executable }]));
}

export const familySkillRepository = {
  /** The family's enabled skills in their working versions, as a turn receives them. */
  async loadWorking(familyId: string): Promise<Record<string, SkillDefinition>> {
    const rows = (await database().query<{ description: string; files: VersionRow["files"]; license: string | null; markdown: string; name: string }>(
      `SELECT skill.name, version.description, version.license, version.markdown, version.files
         FROM family_skills skill
         JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
        WHERE skill.family_id = $1 AND skill.enabled
        ORDER BY skill.name`,
      [familyId],
    )).rows;
    return Object.fromEntries(rows.map((row) => [row.name, {
      description: row.description,
      files: Object.fromEntries(row.files.map((file) => [file.path, Buffer.from(file.content, "base64")])),
      ...(row.license === null ? {} : { license: row.license }),
      markdown: row.markdown,
    }]));
  },

  async grantableSkills(familyId: string): Promise<Map<string, { readonly enabled: boolean; readonly executable: boolean }>> {
    return await grantableFamilySkills(database(), familyId);
  },

  async list(familyId: string): Promise<FamilySkillSummary[]> {
    const rows = (await database().query<{ active_version: number | null; description: string | null; enabled: boolean; latest: number; name: string }>(
      `SELECT skill.name, skill.enabled, skill.active_version, active.description,
              (SELECT max(version) FROM family_skill_versions WHERE skill_id = skill.id) AS latest
         FROM family_skills skill
         LEFT JOIN family_skill_versions active ON active.skill_id = skill.id AND active.version = skill.active_version
        WHERE skill.family_id = $1 ORDER BY skill.name`,
      [familyId],
    )).rows;
    return rows.map((row) => ({
      activeVersion: row.active_version, description: row.description, enabled: row.enabled, latestVersion: row.latest, name: row.name,
    }));
  },

  async versions(familyId: string, name: string): Promise<{ summary: FamilySkillSummary; versions: FamilySkillVersion[] }> {
    const summary = (await this.list(familyId)).find((skill) => skill.name === name);
    if (summary === undefined) throw notFound(name);
    const rows = (await database().query<VersionRow>(
      `SELECT version.version, version.description, version.files, version.content_hash, version.origin_kind, version.origin_url,
              version.created_at, octet_length(version.markdown) AS markdown_size
         FROM family_skill_versions version JOIN family_skills skill ON skill.id = version.skill_id
        WHERE skill.family_id = $1 AND skill.name = $2 ORDER BY version.version DESC`,
      [familyId, name],
    )).rows;
    return { summary, versions: rows.map(toVersion) };
  },

  /**
   * Stores a checked package as the skill's next version; the same content as the latest version
   * is that version again. Nothing works differently until the owner confirms it.
   */
  async stage(input: {
    readonly createdBy: string;
    readonly familyId: string;
    readonly origin: { readonly kind: "authored" } | { readonly kind: "downloaded"; readonly url: string };
    readonly skill: ValidatedSkillPackage;
  }): Promise<{ readonly created: boolean; readonly version: number }> {
    return await asCurrentOwner(input.familyId, input.createdBy, async (client) => {
      await requireRoomForNewSkill(client, input.familyId, input.skill.name);
      const skill = (await client.query<{ id: string }>(
        `INSERT INTO family_skills (family_id, name) VALUES ($1, $2)
         ON CONFLICT (family_id, name) DO UPDATE SET updated_at = now() RETURNING id`,
        [input.familyId, input.skill.name],
      )).rows[0]!;
      const latest = (await client.query<{ content_hash: string; version: number }>(
        "SELECT version, content_hash FROM family_skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [skill.id],
      )).rows[0];
      if (latest !== undefined && latest.content_hash === input.skill.contentHash) return { created: false, version: latest.version };
      const version = (latest?.version ?? 0) + 1;
      await client.query(
        `INSERT INTO family_skill_versions
           (skill_id, version, description, license, markdown, files, content_hash, origin_kind, origin_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
        [
          skill.id, version, input.skill.description, input.skill.license ?? null, input.skill.markdown,
          JSON.stringify(input.skill.files.map((file) => ({
            content: Buffer.from(file.content).toString("base64"), executable: file.executable, path: file.path, size: file.size,
          }))),
          input.skill.contentHash, input.origin.kind, input.origin.kind === "downloaded" ? input.origin.url : null, input.createdBy,
        ],
      );
      await pruneOldVersions(client, skill.id);
      return { created: true, version };
    });
  },

  /** The confirmed version works from the next turn on; the skill is enabled with it. */
  async activate(
    input: { readonly familyId: string; readonly name: string; readonly requestedBy: string; readonly version: number },
  ): Promise<{ readonly previousVersion: number | null }> {
    const { familyId, name, version } = input;
    return await asCurrentOwner(familyId, input.requestedBy, async (client) => {
      const skill = (await client.query<{ active_version: number | null; id: string }>(
        "SELECT id, active_version FROM family_skills WHERE family_id = $1 AND name = $2 FOR UPDATE",
        [familyId, name],
      )).rows[0];
      if (skill === undefined) throw notFound(name);
      const exists = await client.query("SELECT 1 FROM family_skill_versions WHERE skill_id = $1 AND version = $2", [skill.id, version]);
      if (exists.rowCount !== 1) {
        throw new AppError("AGENT_SKILL_VERSION_NOT_FOUND", `У скилла ${name} нет версии ${version}`, { details: { name, version } });
      }
      await requireWorkingSizeWithin(client, familyId, skill.id, version);
      await client.query("UPDATE family_skills SET active_version = $2, enabled = true, updated_at = now() WHERE id = $1", [skill.id, version]);
      return { previousVersion: skill.active_version };
    });
  },

  async setEnabled(
    input: { readonly enabled: boolean; readonly familyId: string; readonly name: string; readonly requestedBy: string },
  ): Promise<void> {
    const { enabled, familyId, name } = input;
    await asCurrentOwner(familyId, input.requestedBy, async (client) => {
      const skill = (await client.query<{ active_version: number | null; id: string }>(
        "SELECT id, active_version FROM family_skills WHERE family_id = $1 AND name = $2 FOR UPDATE",
        [familyId, name],
      )).rows[0];
      if (skill === undefined) throw notFound(name);
      if (enabled && skill.active_version === null) {
        throw new AppError("AGENT_SKILL_NOT_CONFIRMED", `У скилла ${name} ещё нет подтверждённой версии: включать нечего`, { details: { name } });
      }
      if (enabled) await requireWorkingSizeWithin(client, familyId, skill.id, skill.active_version!);
      await client.query("UPDATE family_skills SET enabled = $3, updated_at = now() WHERE family_id = $1 AND name = $2", [familyId, name, enabled]);
    });
  },

  async remove(input: { readonly familyId: string; readonly name: string; readonly requestedBy: string }): Promise<void> {
    await asCurrentOwner(input.familyId, input.requestedBy, async (client) => {
      const deleted = await client.query("DELETE FROM family_skills WHERE family_id = $1 AND name = $2", [input.familyId, input.name]);
      if (deleted.rowCount !== 1) throw notFound(input.name);
      await client.query(
        `UPDATE telegram_groups SET skill_allowlist = array_remove(skill_allowlist, $2)
          WHERE family_id = $1 AND $2 = ANY(skill_allowlist)`,
        [input.familyId, input.name],
      );
    });
  },
};
