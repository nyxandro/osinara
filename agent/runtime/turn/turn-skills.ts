/**
 * The skills of a turn: listed to the model from memory; a skill's files reach the sandbox only
 * when the model loads that skill.
 *
 * Exports:
 * - `prepareTurnSkills`: the turn's skill list, recorded for the session. It never opens the sandbox,
 *   so a plain message does not wake it.
 * - `createStepSkillAccess`: the sandbox and the `load_skill` loader one step's tool contexts share.
 *   Loading reads the skill's current definition and, for a skill that has files, writes its package
 *   into the sandbox skill root as an exact copy before returning the instructions.
 * - `SKILL_DIRECTORY_FOR_MODEL`.
 *
 * Tidying: in a live conversation the first sandbox use of a step removes every skill directory the
 * turn does not grant with files, whatever put it there. A schedule or a delegated task only adds:
 * they share the sandbox home with live turns of the same chat, whose skills differ (a schedule has
 * no service skill, an external group's schedule may have none), and must not pull files from under
 * a turn running beside them.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { Pool } from "pg";

import { saveAnnouncedSkills } from "../history/history-repository.js";
import type { RuntimeSandboxSession } from "../sandbox/types.js";
import type { AnnouncedSkill, LoadedSkill, SkillDefinition } from "../skills/definition.js";
import { toSkillPackage } from "../skills/packages.js";

/** Where a loaded skill's files live, as the model writes the path; bash and file tools expand `$HOME`. */
export const SKILL_DIRECTORY_FOR_MODEL = "$HOME/.agents/skills";

type SkillDefinitions = Readonly<Record<string, SkillDefinition>>;

export async function prepareTurnSkills(input: {
  readonly database: Pick<Pool, "query">;
  readonly definitions: SkillDefinitions;
  readonly sessionId: string;
}): Promise<AnnouncedSkill[]> {
  const skills = Object.entries(input.definitions).map(([name, skill]) => ({ description: skill.description, name }));
  await saveAnnouncedSkills(input.database, { sessionId: input.sessionId, skills });
  return skills;
}

function noSuchSkill(name: string, granted: readonly string[]): Error {
  const available = [...new Set(granted)].sort();
  const hint = available.length > 0 ? ` Available skills: ${available.join(", ")}.` : "";
  return new Error(`No skill named "${name}".${hint}`);
}

function hasFiles(skill: SkillDefinition | undefined): boolean {
  return skill !== undefined && Object.keys(skill.files ?? {}).length > 0;
}

export function createStepSkillAccess(input: {
  /** The skill names listed to the model in this turn. */
  readonly granted: readonly string[];
  readonly openSandbox: () => Promise<RuntimeSandboxSession>;
  /** The turn's skill definitions as they are now; read at most once per step. */
  readonly resolveDefinitions: () => Promise<SkillDefinitions>;
  /** Only a live conversation tidies the skill root (see the module comment). */
  readonly tidy: boolean;
}): { readonly getSandbox: () => Promise<RuntimeSandboxSession>; readonly loadSkill: (name: string) => Promise<LoadedSkill> } {
  let definitions: Promise<SkillDefinitions> | undefined;
  const current = () => (definitions ??= input.resolveDefinitions());
  // What the skill root may hold: the granted skills that have files. A skill without files keeps
  // no directory, so an old copy of one cannot linger.
  const keep = async () => {
    const resolved = await current();
    return input.granted.filter((name) => hasFiles(resolved[name]));
  };
  let sandbox: Promise<RuntimeSandboxSession> | undefined;
  const getSandbox = () => (sandbox ??= input.openSandbox().then(async (opened) => {
    if (input.tidy) await opened.syncSkills([], await keep());
    return opened;
  }));
  async function loadSkill(name: string): Promise<LoadedSkill> {
    if (!input.granted.includes(name)) throw noSuchSkill(name, input.granted);
    // A skill withdrawn after the turn listed it is no longer loadable.
    const skill = (await current())[name];
    if (skill === undefined) throw noSuchSkill(name, input.granted);
    const paths = Object.keys(skill.files ?? {}).sort();
    if (paths.length === 0) return { files: null, markdown: skill.markdown };
    const opened = await getSandbox();
    await opened.syncSkills([toSkillPackage(name, skill)], input.tidy ? await keep() : null);
    return { files: { directory: `${SKILL_DIRECTORY_FOR_MODEL}/${name}`, paths }, markdown: skill.markdown };
  }
  return { getSandbox, loadSkill };
}
