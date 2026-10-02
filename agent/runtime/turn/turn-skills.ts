/**
 * The skills of a turn: synced into the sandbox before the first step, then listed to the model.
 *
 * Export:
 * - `prepareTurnSkills`: writes the turn's packages in one batch, removes the ones the session had
 *   but this turn no longer grants, and records the new list for the next turn's comparison.
 *
 * Derived from eve 0.40.0 `context/dynamic-skill-lifecycle.ts` with Osinara's `skill-sync` patch
 * (one verified batch per turn instead of per-file writes) (Apache-2.0, see NOTICE-eve). A turn
 * without skills, whose session never had any, does not touch the sandbox.
 */
import type { Pool } from "pg";

import { saveAnnouncedSkills } from "../history/history-repository.js";
import { resolveSandboxSkillRoot } from "../sandbox/paths.js";
import type { RuntimeSandboxSession } from "../sandbox/types.js";
import type { AnnouncedSkill, SkillDefinition } from "../skills/definition.js";
import { toSkillPackage } from "../skills/packages.js";

export async function prepareTurnSkills(input: {
  readonly database: Pick<Pool, "query">;
  readonly definitions: Readonly<Record<string, SkillDefinition>>;
  readonly previous: readonly AnnouncedSkill[] | null;
  readonly sandbox: () => Promise<RuntimeSandboxSession>;
  readonly sessionId: string;
}): Promise<{ readonly skillRoot: string | null; readonly skills: AnnouncedSkill[] }> {
  const entries = Object.entries(input.definitions);
  const skills = entries.map(([name, skill]) => ({ description: skill.description, name }));
  const names = new Set(skills.map((skill) => skill.name));
  const removed = (input.previous ?? []).map((skill) => skill.name).filter((name) => !names.has(name));
  if (skills.length === 0 && removed.length === 0) return { skillRoot: null, skills };
  const sandbox = await input.sandbox();
  await sandbox.syncSkills(entries.map(([name, skill]) => toSkillPackage(name, skill)), removed);
  const skillRoot = skills.length === 0 ? null : await resolveSandboxSkillRoot(sandbox);
  await saveAnnouncedSkills(input.database, { sessionId: input.sessionId, skills });
  return { skillRoot, skills };
}
