/**
 * Dynamic image generation skill package.
 *
 * Exports:
 * - `IMAGE_GENERATION_SKILL_NAME`: stable runtime skill identifier.
 * - `IMAGE_GENERATION_SKILL_DEFINITION`: reviewed instructions paired with `generate_image`.
 * - `isImageGenerationSkillName`: exact identifier guard for external live authorization.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "eve/skills";

export const IMAGE_GENERATION_SKILL_NAME = "imagegen" as const;

export function isImageGenerationSkillName(value: string): value is typeof IMAGE_GENERATION_SKILL_NAME {
  return value === IMAGE_GENERATION_SKILL_NAME;
}

const instructions = readFileSync(
  resolve("config/capability-skills/imagegen/instructions.md"),
  "utf8",
);

export const IMAGE_GENERATION_SKILL_DEFINITION: SkillDefinition = defineSkill({
  description:
    "Создание одного нового raster-изображения через GPT-Image-2 с безопасным prompt workflow, workspace persistence и Telegram delivery.",
  markdown: instructions,
});
