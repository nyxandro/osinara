/**
 * The release's service skills: procedures the model loads before using a tool it rarely needs.
 *
 * Exports:
 * - `SKILL_MANAGER_NAME`, `isServiceSkillName`: the reserved names; a family skill cannot take one.
 * - `isServiceSkillOf`: whether a name is a service skill of the given trust zone.
 * - `serviceSkillsFor`: the service skills of one turn, from its trust zone and its tool surface.
 *
 * A service skill exists in a turn exactly when the turn has one of its tools: the descriptor of the
 * tool says to load it, and the mode block keeps only when to reach for it. Each skill belongs to the
 * trust zones its text describes, so an external group never reads the family's procedures. Every
 * package is read once from `config/service-skills/` at process start, checked by the same rules as
 * any other skill; a broken package stops the process at start.
 */
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "../../runtime/skills/definition.js";
import { validateSkillPackage } from "../../runtime/skills/package-validation.js";
import type { ConversationEnvironment } from "../conversation-environment.js";
import { readSkillPackageFiles } from "../group-skills/group-skill-definitions.js";

export const SKILL_MANAGER_NAME = "skill-manager";
const SERVICE_SKILL_ROOT = resolve("config/service-skills");

interface ServiceSkill {
  readonly environments: ReadonlySet<ConversationEnvironment>;
  readonly name: string;
  readonly tools: readonly string[];
}

const TRUSTED: ReadonlySet<ConversationEnvironment> = new Set(["private", "family"]);

const SERVICE_SKILLS: readonly ServiceSkill[] = [
  { environments: new Set(["private"]), name: SKILL_MANAGER_NAME, tools: ["manage_skill"] },
  { environments: TRUSTED, name: "schedules", tools: ["manage_reminder", "manage_agent_schedule"] },
  { environments: new Set(["external"]), name: "group-reminders", tools: ["manage_reminder"] },
  { environments: new Set(["private", "family", "external"]), name: "voice-replies", tools: ["send_voice_message"] },
  { environments: new Set(["private"]), name: "group-admin", tools: ["manage_telegram_group", "manage_family_invitation"] },
  { environments: new Set(["private"]), name: "api-keys", tools: ["manage_api_keys"] },
  { environments: new Set(["private", "family", "external"]), name: "delegation", tools: ["agent"] },
];

function loadServiceSkill(name: string): SkillDefinition {
  const validated = validateSkillPackage({ expectedName: name, files: readSkillPackageFiles(SERVICE_SKILL_ROOT, name), limits: null });
  return defineSkill({
    description: validated.description,
    files: Object.fromEntries(validated.files.map((file) => [file.path, file.content])),
    markdown: validated.markdown,
  });
}

const DEFINITIONS: Readonly<Record<string, SkillDefinition>> = Object.fromEntries(
  SERVICE_SKILLS.map((skill) => [skill.name, loadServiceSkill(skill.name)]),
);

export function isServiceSkillName(name: string): boolean {
  return Object.hasOwn(DEFINITIONS, name);
}

export function isServiceSkillOf(environment: ConversationEnvironment, name: string): boolean {
  return SERVICE_SKILLS.some((skill) => skill.name === name && skill.environments.has(environment));
}

export function serviceSkillsFor(
  environment: ConversationEnvironment,
  toolNames: ReadonlySet<string>,
): Record<string, SkillDefinition> {
  return Object.fromEntries(SERVICE_SKILLS
    .filter((skill) => skill.environments.has(environment) && skill.tools.some((tool) => toolNames.has(tool)))
    .map((skill) => [skill.name, DEFINITIONS[skill.name]!]));
}
