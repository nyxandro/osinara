/**
 * Skill package definition: instructions plus optional sibling files.
 *
 * Exports:
 * - `SkillDefinition`, `SkillFileContent`: a skill's description, `SKILL.md` body and files.
 * - `defineSkill`: types a skill definition; extra keys are a compile error.
 *
 * Derived from eve 0.40.0 `public/definitions/skill.ts`, `shared/skill-definition.ts` and
 * `public/definitions/exact.ts` (Apache-2.0, see NOTICE-eve). Changes: plain objects without
 * Eve's brand stamp; the runtime identifies skills by catalog name, not by the stamp.
 */
export type SkillFileContent = string | Uint8Array;

export interface SkillDefinition {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Record<string, string>;
  readonly files?: Readonly<Record<string, SkillFileContent>>;
}

type ExactDefinition<TInput, TShape> = TInput & {
  readonly [TKey in Exclude<keyof TInput, keyof TShape>]: never;
};

export function defineSkill<TSkill extends SkillDefinition>(
  definition: ExactDefinition<TSkill, SkillDefinition>,
): TSkill {
  return definition;
}
