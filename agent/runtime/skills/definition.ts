/**
 * Skill package definition: instructions plus optional sibling files.
 *
 * Exports:
 * - `SkillDefinition`, `SkillFileContent`: a skill's description, `SKILL.md` body and files.
 * - `defineSkill`: types a skill definition; extra keys are a compile error.
 * - `AnnouncedSkill`: one entry of the skill list the model was last told about.
 *
 * Plain objects: the runtime identifies skills by catalog name.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export type SkillFileContent = string | Uint8Array;

export interface SkillDefinition {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Record<string, string>;
  readonly files?: Readonly<Record<string, SkillFileContent>>;
}

export interface AnnouncedSkill {
  readonly description: string;
  readonly name: string;
}

type ExactDefinition<TInput, TShape> = TInput & {
  readonly [TKey in Exclude<keyof TInput, keyof TShape>]: never;
};

export function defineSkill<TSkill extends SkillDefinition>(
  definition: ExactDefinition<TSkill, SkillDefinition>,
): TSkill {
  return definition;
}
