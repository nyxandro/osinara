/** Atomic owner-managed group permissions and executable skill dependencies. */
import type { PoolClient } from "pg";
import { SANDBOX_RUNNER_BASE_URL, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { workingFamilySkills } from "./family-skills/family-skill-repository.js";
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

/** `skillsNeedBash`: the group's skills run scripts, so Bash stays (or was just) granted with them. */
export async function updateGroupPermissions(
  input: TelegramGroupPolicyUpdate | TelegramGroupSkillUpdate,
): Promise<{ groupId: string; skillsNeedBash: boolean }> {
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
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED]);
    const result = await client.query<{
      id: string; family_id: string; type: string; message_mode: string; skill_allowlist: string[]; tool_allowlist: string[];
    }>("SELECT id,family_id,type,message_mode,skill_allowlist,tool_allowlist FROM telegram_groups WHERE telegram_chat_id=$1 FOR UPDATE", [input.telegramChatId]);
    const group = result.rows[0];
    if (!group || group.family_id !== input.familyId) throw new AppError("AGENT_GROUP_NOT_FOUND", "Группа не найдена в вашей семье");
    if (group.type !== "external") throw new AppError("AGENT_GROUP_POLICY_UPDATE_UNSUPPORTED", "В семейном чате все установленные скиллы доступны автоматически");
    // The family's skills are read under the same transaction, so the check and the grant agree.
    const catalog = skillGrantCatalog(await workingFamilySkills(client, input.familyId));
    if (changingSkills) requireGrantableSkills(catalog, [...providedSkills!]);
    const needsBash = (name: string) => skillNeedsBash(catalog, name);
    let skills = changingSkills ? [...providedSkills!] : group.skill_allowlist;
    const tools = new Set(changingSkills ? group.tool_allowlist : [...providedTools!]);
    if (changingSkills && skills.some(needsBash)) tools.add("bash");
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
    await client.query(
      `INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
       VALUES($1,'telegram_group.permissions_updated',$2,$3)`,
      [input.familyId, group.id, { requestedBy: input.requestedBy, skillAllowlist: skills, toolAllowlist }],
    );
    await client.query("COMMIT");
    return { groupId: group.id, skillsNeedBash: skills.some(needsBash) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
