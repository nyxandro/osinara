/**
 * How much a family's own skills may take, checked inside the change's transaction.
 *
 * Exports:
 * - `requireWorkingSizeWithin`: the family's enabled skills together stay within what a turn may
 *   carry to the sandbox.
 * - `requireRoomForNewSkill`: a family has a bounded number of skills.
 * - `pruneOldVersions`: a skill keeps its newest versions and the working one.
 *
 * Callers hold the family's skill lock (`family-skill-repository.ts`), so two changes cannot pass
 * a check together.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";

// Every turn reads all enabled skills of the family and sends them to the sandbox in one request
// (with the built-in ones, under the runner's 64 MB request limit).
const FAMILY_WORKING_SKILLS_MAX_BYTES = 8 * 1024 * 1024;
// A package is up to 2 MB: these bound what a stuck or misled task can store.
const FAMILY_SKILLS_MAX = 30;
const FAMILY_SKILL_VERSIONS_KEPT = 5;

/** `skillId` working with `version`, the family's other enabled skills as they are. */
export async function requireWorkingSizeWithin(client: PoolClient, familyId: string, skillId: string, version: number): Promise<void> {
  const total = Number((await client.query<{ total: string }>(
    `SELECT coalesce(sum(octet_length(version.markdown)
              + (SELECT coalesce(sum((file->>'size')::bigint), 0) FROM jsonb_array_elements(version.files) file)), 0) AS total
       FROM family_skills skill
       JOIN family_skill_versions version
         ON version.skill_id = skill.id AND version.version = CASE WHEN skill.id = $2 THEN $3 ELSE skill.active_version END
      WHERE skill.family_id = $1 AND (skill.enabled OR skill.id = $2)`,
    [familyId, skillId, version],
  )).rows[0]!.total);
  if (total > FAMILY_WORKING_SKILLS_MAX_BYTES) {
    throw new AppError("AGENT_SKILL_FAMILY_LIMIT_REACHED",
      "Включённые скиллы семьи вместе займут больше 8 МБ. Выключите или удалите ненужные скиллы и повторите", {
        details: { total },
      });
  }
}

export async function requireRoomForNewSkill(client: PoolClient, familyId: string, name: string): Promise<void> {
  const counted = (await client.query<{ exists: boolean; skills: number }>(
    `SELECT count(*)::integer AS skills, bool_or(name = $2) AS exists FROM family_skills WHERE family_id = $1`,
    [familyId, name],
  )).rows[0]!;
  if (counted.exists !== true && counted.skills >= FAMILY_SKILLS_MAX) {
    throw new AppError("AGENT_SKILL_FAMILY_LIMIT_REACHED",
      `У семьи уже ${FAMILY_SKILLS_MAX} скиллов. Удалите ненужный скилл и повторите`, { details: { skills: counted.skills } });
  }
}

/** Older versions beyond the newest ones are removed; the working version always stays. */
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
