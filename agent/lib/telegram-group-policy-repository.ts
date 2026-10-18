/**
 * Atomic owner-managed group permissions and executable skill dependencies.
 *
 * A skill list changes without a confirmation button, so it never grants Bash by itself: a skill
 * that runs scripts needs the group to have Bash already, which only a confirmed rights change gives.
 * Each skill list change sends the owner a notice (`family-skills/family-skill-notices.ts`).
 */
import type { PoolClient } from "pg";
import { FAMILY_SKILLS_LOCK_HASH_SEED, SANDBOX_RUNNER_BASE_URL, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { enqueueFamilySkillNotice } from "./family-skills/family-skill-notices.js";
import { grantableFamilySkills } from "./family-skills/family-skill-repository.js";
import { requireGrantableSkills, skillGrantCatalog, skillNeedsBash } from "./family-skills/skill-grants.js";
import { parseGroupSkillAllowlist } from "./group-skills/group-skill-catalog.js";
import { SandboxRunnerClient } from "./sandbox-runner/runner-client.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import type { TelegramGroupPolicyUpdate, TelegramGroupSkillUpdate } from "./telegram-group-administration-repository.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export async function stopGroupSandboxes(client: PoolClient, groupId: string): Promise<void> {
  const sessions = await client.query<{ thread_id: string }>(
    "SELECT DISTINCT thread_id::text FROM conversation_sessions WHERE group_id=$1", [groupId],
  );
  for (const session of sessions.rows) await runner.stop(session.thread_id);
}

export async function updateGroupPermissions(
  input: TelegramGroupPolicyUpdate | TelegramGroupSkillUpdate,
): Promise<{ groupId: string }> {
  const changingSkills = "skillAllowlist" in input;
  const providedSkills = changingSkills ? parseGroupSkillAllowlist(input.skillAllowlist) : null;
  const providedTools = "toolAllowlist" in input ? parseExternalGroupToolAllowlist(input.toolAllowlist) : null;
  if ((changingSkills && !providedSkills) || (!changingSkills && !providedTools)) {
    throw new AppError("AGENT_GROUP_POLICY_INVALID", "Список прав содержит неизвестные или повторяющиеся значения");
  }
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role='owner' FOR SHARE",
      [input.familyId, input.requestedBy],
    );
    if (!owner.rowCount) throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
    // The family's skill lock first, in the same order as every skill change: a skill deleted meanwhile
    // cannot stay on this list and be granted again to a later skill under its name.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [input.familyId, FAMILY_SKILLS_LOCK_HASH_SEED]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED]);
    const result = await client.query<{
      id: string; family_id: string; type: string; message_mode: string; skill_allowlist: string[]; title: string; tool_allowlist: string[];
    }>("SELECT id,family_id,type,message_mode,skill_allowlist,title,tool_allowlist FROM telegram_groups WHERE telegram_chat_id=$1 FOR UPDATE", [input.telegramChatId]);
    const group = result.rows[0];
    if (!group || group.family_id !== input.familyId) throw new AppError("AGENT_GROUP_NOT_FOUND", "Группа не найдена в вашей семье");
    if (group.type !== "external") {
      throw new AppError("AGENT_GROUP_POLICY_UPDATE_UNSUPPORTED",
        "В семейном чате встроенные скиллы работают всегда, а скиллы семьи включает любой член семьи через manage_skill");
    }
    // The family's skills are read under the same transaction, so the check and the grant agree.
    const catalog = skillGrantCatalog(await grantableFamilySkills(client, input.familyId));
    if (changingSkills) requireGrantableSkills(catalog, [...providedSkills!]);
    const needsBash = (name: string) => skillNeedsBash(catalog, name);
    let skills = changingSkills ? [...providedSkills!] : group.skill_allowlist;
    const tools = new Set(changingSkills ? group.tool_allowlist : [...providedTools!]);
    const withoutBash = changingSkills && !tools.has("bash") ? skills.filter(needsBash) : [];
    if (withoutBash.length > 0) {
      throw new AppError("AGENT_GROUP_SKILL_NEEDS_BASH",
        `Скиллам ${withoutBash.join(", ")} нужны команды в песочнице, а у группы их нет. Сначала разрешите группе bash ` +
        "(это изменение прав группы, с подтверждением), затем добавьте скиллы", { details: { skills: withoutBash.join(",") } });
    }
    if (!changingSkills && !tools.has("bash")) skills = skills.filter((name) => !needsBash(name));
    const toolAllowlist = [...tools];
    const changed = JSON.stringify(skills) !== JSON.stringify(group.skill_allowlist) ||
      JSON.stringify(toolAllowlist) !== JSON.stringify(group.tool_allowlist);
    // The locked registration blocks new sandbox policy reads until revocation commits. Removing
    // old compute kills running scripts/browser processes without deleting the group's files.
    if (changed) await stopGroupSandboxes(client, group.id);
    await client.query(
      "UPDATE telegram_groups SET skill_allowlist=$2,tool_allowlist=$3,message_mode=$4 WHERE id=$1",
      [group.id, skills, toolAllowlist, "messageMode" in input ? input.messageMode : group.message_mode],
    );
    const audit = await client.query<{ id: string }>(
      `INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
       VALUES($1,'telegram_group.permissions_updated',$2,$3) RETURNING id`,
      [input.familyId, group.id, { requestedBy: input.requestedBy, skillAllowlist: skills, toolAllowlist }],
    );
    if (changingSkills && JSON.stringify(skills) !== JSON.stringify(group.skill_allowlist)) {
      await enqueueFamilySkillNotice(client, {
        familyId: input.familyId,
        operationKey: `group-skills:${audit.rows[0]!.id}`,
        recipient: { userId: input.requestedBy },
        text: `Скиллы группы «${group.title}» теперь: ${skills.length === 0 ? "нет ни одного" : skills.join(", ")}.`,
      });
    }
    await client.query("COMMIT");
    return { groupId: group.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
