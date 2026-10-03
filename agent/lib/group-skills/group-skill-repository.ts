/**
 * Live PostgreSQL group skill policy lookup.
 *
 * Exports:
 * - `GroupSkillPolicyRepository`: injectable exact-group allowlist contract.
 * - `groupSkillPolicyRepository`: fail-closed production implementation. It returns the skills the
 *   group's list grants that still exist now: built-in ones and the family's enabled ones. A family
 *   skill the owner disabled or deleted drops out of the result while the stored list stays as is.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  isGroupSafeSkillName,
  parseGroupSkillAllowlist,
  type GroupSafeSkillName,
} from "./group-skill-catalog.js";

export interface GroupSkillPolicyRepository {
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

export const groupSkillPolicyRepository: GroupSkillPolicyRepository = {
  async loadGroupSkillAllowlist(groupId) {
    const result = await database().query<{ family_skills: string[]; skill_allowlist: string[] }>(
      `SELECT g.skill_allowlist,
              ARRAY(SELECT s.name FROM family_skills s WHERE s.family_id = g.family_id AND s.enabled) AS family_skills
         FROM telegram_groups g
        WHERE g.id = $1`,
      [groupId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_GROUP_SKILL_POLICY_NOT_FOUND",
        "Не удалось найти актуальную политику skills этой группы",
      );
    }
    const allowed = parseGroupSkillAllowlist(row.skill_allowlist);
    if (!allowed) {
      throw new AppError(
        "AGENT_GROUP_SKILL_POLICY_INVALID",
        "Политика skills группы повреждена. Обратитесь к владельцу агента",
      );
    }
    const family = new Set(row.family_skills);
    return new Set([...allowed].filter((name) => isGroupSafeSkillName(name) || family.has(name)));
  },
};
