/**
 * How much a family's skill library may hold, checked inside the change's transaction.
 *
 * Exports:
 * - `requireRoomForNewSkill`: a family has a bounded number of skills.
 * - `pruneOldVersions`: a skill keeps its newest versions and the current one.
 *
 * Callers hold the family's skill lock (`family-skill-changes.ts`), so two changes cannot pass a
 * check together. A turn sends one loaded skill to the sandbox at a time, so the library has no
 * bound on the total size of its skills beyond each package's own limit.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";

// A package is up to 2 MB: these bound what a stuck or misled task can store.
const FAMILY_SKILLS_MAX = 30;
const FAMILY_SKILL_VERSIONS_KEPT = 5;

export async function requireRoomForNewSkill(client: PoolClient, familyId: string, name: string): Promise<void> {
  const counted = (await client.query<{ exists: boolean; skills: number }>(
    `SELECT count(*)::integer AS skills, bool_or(name = $2) AS exists FROM family_skills WHERE family_id = $1`,
    [familyId, name],
  )).rows[0]!;
  if (counted.exists !== true && counted.skills >= FAMILY_SKILLS_MAX) {
    throw new AppError("AGENT_SKILL_FAMILY_LIMIT_REACHED",
      `В библиотеке семьи уже ${FAMILY_SKILLS_MAX} скиллов. Удалите ненужный скилл и повторите`, { details: { skills: counted.skills } });
  }
}

/** Older versions beyond the newest ones are removed; the current version always stays. */
export async function pruneOldVersions(client: PoolClient, skillId: string): Promise<void> {
  await client.query(
    `DELETE FROM family_skill_versions version
      USING family_skills skill
      WHERE skill.id = $1 AND version.skill_id = skill.id
        AND version.version IS DISTINCT FROM skill.active_version
        AND version.version <= (SELECT max(version) FROM family_skill_versions WHERE skill_id = $1) - $2`,
    [skillId, FAMILY_SKILL_VERSIONS_KEPT],
  );
}
