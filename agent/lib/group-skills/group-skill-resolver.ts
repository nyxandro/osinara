/**
 * The skills of one turn: the release's built-in skills plus the family's own working ones.
 *
 * Exports:
 * - `resolveConversationSkills`: private and family chats get every skill of the catalog; an
 *   external group gets the skills its verified list names that still exist.
 * - `resolveExternalGroupSkillNames`: just those names for an external group, from the turn's
 *   verified list and the group's live list together, for the step's tool surface.
 *
 * The family's skills are read from the database on every turn, so a skill the owner confirms,
 * disables or deletes takes effect from the next turn without a new context. A built-in skill keeps
 * its name if a family skill with the same name appears later.
 */
import type { SessionAuth } from "../../runtime/context.js";
import type { SkillDefinition } from "../../runtime/skills/definition.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { familySkillRepository } from "../family-skills/family-skill-repository.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { IMAGE_GENERATION_SKILL_DEFINITION, IMAGE_GENERATION_SKILL_NAME } from "../image-generation/image-generation-skill.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupSkillPolicy,
  resolveExternalGroupToolPolicy,
} from "../tool-policy/external-group-policy.js";
import { GROUP_SAFE_SKILL_NAMES, isGroupSafeSkillName } from "./group-skill-catalog.js";
import { GROUP_SAFE_SKILL_DEFINITIONS } from "./group-skill-definitions.js";
import { groupSkillPolicyRepository } from "./group-skill-repository.js";

/** The family a trusted conversation belongs to; a conversation before the family exists has none. */
function trustedFamilyId(auth: SessionAuth): string | null {
  const familyId = auth.current?.attributes.familyId;
  return typeof familyId === "string" ? familyId : null;
}

export async function resolveConversationSkills(
  auth: SessionAuth,
  options: { scheduledRun?: boolean; subagent?: boolean } = {},
): Promise<Record<string, SkillDefinition>> {
  const external = resolveConversationEnvironment(auth) === "external";
  const familyId = external ? resolveExternalGroupPolicyIdentity(auth)?.familyId ?? null : trustedFamilyId(auth);
  const family = familyId === null ? {} : await familySkillRepository.loadWorking(familyId);
  const catalog: Record<string, SkillDefinition> = { ...family, ...GROUP_SAFE_SKILL_DEFINITIONS };
  // A group's skills keep the order of its list; a trusted chat lists built-in skills first.
  const granted = external
    ? [...resolveExternalGroupSkillPolicy(auth)]
    : [...GROUP_SAFE_SKILL_NAMES, ...Object.keys(family).filter((name) => !isGroupSafeSkillName(name))];
  const tools = resolveExternalGroupToolPolicy(auth);
  const imageGenerationEnabled = IMAGE_GENERATION_AVAILABLE &&
    options.scheduledRun !== true && options.subagent !== true &&
    (!external || (tools.restricted && tools.allowed.has("generate_image")));
  return {
    ...Object.fromEntries(granted.flatMap((name) => catalog[name] === undefined ? [] : [[name, catalog[name]]])),
    ...(imageGenerationEnabled ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION } : {}),
  };
}

export async function resolveExternalGroupSkillNames(auth: SessionAuth): Promise<ReadonlySet<string>> {
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (identity === null) return new Set();
  const live = await groupSkillPolicyRepository.loadGroupSkillAllowlist(identity.groupId);
  return new Set([...resolveExternalGroupSkillPolicy(auth)].filter((name) => live.has(name)));
}
