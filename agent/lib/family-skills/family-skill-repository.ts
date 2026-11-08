/**
 * The family's skill library in PostgreSQL: what a conversation receives and what people see.
 *
 * Exports:
 * - `familySkillRepository`: the skills a turn receives (a person's own selection, or a list of
 *   names for a group); the library as one person sees it; a skill's versions; the current version
 *   as files, for a checkout into a workspace.
 * - `grantableFamilySkills`: every skill with a current version (a group's list may name it), and
 *   whether that version runs scripts; read inside the caller's transaction.
 * - `FamilySkillSummary`, `FamilySkillVersion`, `StoredSkillFile`, `FamilySkillSelection`.
 *
 * Changes live in `family-skill-changes.ts`. A skill's current version is the one every person who
 * enabled it gets; a skill without one (stored before versions became current on save) works nowhere.
 */
import type { Pool, PoolClient } from "pg";

import type { SkillDefinition } from "../../runtime/skills/definition.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export interface StoredSkillFile {
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

export interface FamilySkillVersion {
  /** ISO time: a tool result reaches the model as JSON, which has no dates. */
  readonly createdAt: string;
  readonly description: string;
  readonly files: readonly StoredSkillFile[];
  /** Bytes of the `SKILL.md` instructions after the header. */
  readonly markdownSize: number;
  readonly origin: { readonly kind: "authored" } | { readonly kind: "downloaded"; readonly url: string };
  readonly version: number;
}

export interface FamilySkillSummary {
  readonly activeVersion: number | null;
  /** Who added the skill to the library, as the family knows them. */
  readonly author: string | null;
  readonly description: string | null;
  /** Whether the person asking has it enabled for themselves. */
  readonly enabledForMe: boolean;
  /** Titles of the family groups whose list holds it. */
  readonly familyGroups: readonly string[];
  readonly latestVersion: number;
  readonly name: string;
}

/**
 * Whose skills a conversation gets: a person's own selection, the names a group's list holds, or what the owner gave
 * a live guest (#474), read with the skills in one statement so a skill deleted and made anew under a given name
 * between two reads is never handed out.
 */
export type FamilySkillSelection =
  | { readonly enabledBy: string }
  | { readonly givenToGuestFamily: string }
  | { readonly names: readonly string[] };

function selectionCondition(selection: FamilySkillSelection): { readonly condition: string; readonly value: unknown } {
  if ("enabledBy" in selection) {
    return {
      condition: "EXISTS (SELECT 1 FROM family_skill_activations activation WHERE activation.skill_id = skill.id AND activation.user_id = $2)",
      value: selection.enabledBy,
    };
  }
  if ("givenToGuestFamily" in selection) {
    return {
      condition: `skill.name = ANY(COALESCE((SELECT guest.granted_skills FROM guest_accounts guest
                    WHERE guest.guest_family_id = $2::uuid AND guest.host_family_id = skill.family_id
                      AND guest.status = 'active'), '{}'))`,
      value: selection.givenToGuestFamily,
    };
  }
  return { condition: "skill.name = ANY($2::text[])", value: [...selection.names] };
}

interface StoredFileRow extends StoredSkillFile {
  readonly content: string;
}

interface VersionRow {
  created_at: Date;
  description: string;
  files: StoredFileRow[];
  markdown_size: number;
  origin_kind: "authored" | "downloaded";
  origin_url: string | null;
  version: number;
}

function toVersion(row: VersionRow): FamilySkillVersion {
  return {
    createdAt: row.created_at.toISOString(),
    description: row.description,
    files: row.files.map(({ executable, path, size }) => ({ executable, path, size })),
    markdownSize: row.markdown_size,
    origin: row.origin_kind === "downloaded" ? { kind: "downloaded", url: row.origin_url! } : { kind: "authored" },
    version: row.version,
  };
}

export function familySkillNotFound(name: string): AppError {
  return new AppError("AGENT_SKILL_NOT_FOUND", `Скилла ${name} нет в библиотеке семьи`, { details: { name } });
}

export async function grantableFamilySkills(
  queryable: Pick<Pool | PoolClient, "query">,
  familyId: string,
): Promise<Map<string, { readonly executable: boolean }>> {
  const rows = (await queryable.query<{ executable: boolean; name: string }>(
    `SELECT skill.name,
            EXISTS (SELECT 1 FROM jsonb_array_elements(version.files) file WHERE (file->>'executable')::boolean) AS executable
       FROM family_skills skill
       JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
      WHERE skill.family_id = $1`,
    [familyId],
  )).rows;
  return new Map(rows.map((row) => [row.name, { executable: row.executable }]));
}

export const familySkillRepository = {
  /** The selected skills in their current versions, as a turn receives them. */
  async loadWorking(familyId: string, selection: FamilySkillSelection): Promise<Record<string, SkillDefinition>> {
    if ("names" in selection && selection.names.length === 0) return {};
    const { condition, value } = selectionCondition(selection);
    const rows = (await database().query<{ description: string; files: StoredFileRow[]; license: string | null; markdown: string; name: string }>(
      `SELECT skill.name, version.description, version.license, version.markdown, version.files
         FROM family_skills skill
         JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
        WHERE skill.family_id = $1 AND ${condition}
        ORDER BY skill.name`,
      [familyId, value],
    )).rows;
    return Object.fromEntries(rows.map((row) => [row.name, {
      description: row.description,
      files: Object.fromEntries(row.files.map((file) => [file.path, Buffer.from(file.content, "base64")])),
      ...(row.license === null ? {} : { license: row.license }),
      markdown: row.markdown,
    }]));
  },

  async grantableSkills(familyId: string): Promise<Map<string, { readonly executable: boolean }>> {
    return await grantableFamilySkills(database(), familyId);
  },

  /** The library as `userId` sees it. */
  async list(familyId: string, userId: string): Promise<FamilySkillSummary[]> {
    const rows = (await database().query<{
      active_version: number | null; author: string | null; description: string | null; enabled_for_me: boolean;
      family_groups: string[]; latest: number; name: string;
    }>(
      `SELECT skill.name, skill.active_version, active.description, author.display_name AS author,
              EXISTS (SELECT 1 FROM family_skill_activations activation
                       WHERE activation.skill_id = skill.id AND activation.user_id = $2) AS enabled_for_me,
              ARRAY(SELECT title FROM telegram_groups
                     WHERE family_id = skill.family_id AND type = 'family_private' AND skill.name = ANY(skill_allowlist)
                     ORDER BY title) AS family_groups,
              (SELECT max(version) FROM family_skill_versions WHERE skill_id = skill.id) AS latest
         FROM family_skills skill
         LEFT JOIN family_skill_versions active ON active.skill_id = skill.id AND active.version = skill.active_version
         LEFT JOIN users author ON author.id = skill.author_user_id
        WHERE skill.family_id = $1 ORDER BY skill.name`,
      [familyId, userId],
    )).rows;
    return rows.map((row) => ({
      activeVersion: row.active_version, author: row.author, description: row.description, enabledForMe: row.enabled_for_me,
      familyGroups: row.family_groups, latestVersion: row.latest, name: row.name,
    }));
  },

  async versions(familyId: string, userId: string, name: string): Promise<{ summary: FamilySkillSummary; versions: FamilySkillVersion[] }> {
    const summary = (await this.list(familyId, userId)).find((skill) => skill.name === name);
    if (summary === undefined) throw familySkillNotFound(name);
    const rows = (await database().query<VersionRow>(
      `SELECT version.version, version.description, version.files, version.origin_kind, version.origin_url,
              version.created_at, octet_length(version.markdown) AS markdown_size
         FROM family_skill_versions version JOIN family_skills skill ON skill.id = version.skill_id
        WHERE skill.family_id = $1 AND skill.name = $2 ORDER BY version.version DESC`,
      [familyId, name],
    )).rows;
    return { summary, versions: rows.map(toVersion) };
  },

  /** The current version's parts, to write back into a workspace folder. */
  async currentPackage(familyId: string, name: string): Promise<{
    readonly description: string; readonly files: ReadonlyArray<{ readonly content: Buffer; readonly path: string }>;
    readonly license: string | null; readonly markdown: string; readonly version: number;
  }> {
    const row = (await database().query<{ description: string; files: StoredFileRow[]; license: string | null; markdown: string; version: number }>(
      `SELECT version.version, version.description, version.license, version.markdown, version.files
         FROM family_skills skill
         JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
        WHERE skill.family_id = $1 AND skill.name = $2`,
      [familyId, name],
    )).rows[0];
    if (row === undefined) throw familySkillNotFound(name);
    return {
      description: row.description,
      files: row.files.map((file) => ({ content: Buffer.from(file.content, "base64"), path: file.path })),
      license: row.license, markdown: row.markdown, version: row.version,
    };
  },
};
