/**
 * The skills of one turn: the release's built-in skills plus the family's own ones this conversation has.
 *
 * Exports:
 * - `resolveConversationSkills`: a private chat gets every built-in skill, the family skills its
 *   person enabled for themselves and the service `skill-manager`; a family group gets every built-in
 *   skill and the family skills on its list; an external group gets the skills of its verified list
 *   that still exist.
 * - `resolveExternalGroupSkillNames`: just those names for an external group, from the turn's
 *   verified list and the group's live list together, for the step's tool surface.
 *
 * The family's skills are read from the database on every turn, so a change takes effect from the
 * next turn without a new context. A built-in skill keeps its name if a family skill with the same
 * name appears later.
 */
import type { SessionAuth } from "../../runtime/context.js";
import type { SkillDefinition } from "../../runtime/skills/definition.js";
import { AppError } from "../app-error.js";
import { resolveConversationEnvironment, type ConversationEnvironment } from "../conversation-environment.js";
import { familySkillRepository, type FamilySkillSelection } from "../family-skills/family-skill-repository.js";
import { SERVICE_SKILL_DEFINITIONS } from "../family-skills/service-skills.js";
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

function skillContextInvalid(): AppError {
  return new AppError("AGENT_SKILL_CONTEXT_INVALID", "Не удалось определить, чьи скиллы выдать в этом чате. Отправьте сообщение ещё раз");
}

/** Whose family skills a trusted conversation gets. */
async function trustedSelection(auth: SessionAuth, environment: Exclude<ConversationEnvironment, "external">): Promise<FamilySkillSelection> {
  const caller = auth.current;
  if (environment === "private") {
    if (caller?.principalType !== "user") throw skillContextInvalid();
    return { enabledBy: caller.principalId };
  }
  const groupId = caller?.attributes.groupId;
  if (typeof groupId !== "string") throw skillContextInvalid();
  return { names: [...await groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId)].filter((name) => !isGroupSafeSkillName(name)) };
}

export async function resolveConversationSkills(
  auth: SessionAuth,
  options: { scheduledRun?: boolean; subagent?: boolean } = {},
): Promise<Record<string, SkillDefinition>> {
  const environment = resolveConversationEnvironment(auth);
  const external = environment === "external";
  const familyId = external ? resolveExternalGroupPolicyIdentity(auth)?.familyId ?? null : trustedFamilyId(auth);
  // A group's skills keep the order of its list; a trusted chat lists built-in skills first.
  const granted = external
    ? [...resolveExternalGroupSkillPolicy(auth)]
    : [...GROUP_SAFE_SKILL_NAMES];
  const selection: FamilySkillSelection | null = familyId === null ? null : external
    ? { names: granted.filter((name) => !isGroupSafeSkillName(name)) }
    : await trustedSelection(auth, environment);
  const family = selection === null ? {} : await familySkillRepository.loadWorking(familyId!, selection);
  const catalog: Record<string, SkillDefinition> = { ...family, ...GROUP_SAFE_SKILL_DEFINITIONS };
  const names = external ? granted : [...granted, ...Object.keys(family).filter((name) => !isGroupSafeSkillName(name))];
  const tools = resolveExternalGroupToolPolicy(auth);
  const live = options.scheduledRun !== true && options.subagent !== true;
  const imageGenerationEnabled = IMAGE_GENERATION_AVAILABLE && live &&
    (!external || (tools.restricted && tools.allowed.has("generate_image")));
  return {
    ...Object.fromEntries(names.flatMap((name) => catalog[name] === undefined ? [] : [[name, catalog[name]]])),
    // Skills are changed only in a person's own conversation, never by a schedule or a delegated task.
    ...(environment === "private" && live ? SERVICE_SKILL_DEFINITIONS : {}),
    ...(imageGenerationEnabled ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION } : {}),
  };
}

export async function resolveExternalGroupSkillNames(auth: SessionAuth): Promise<ReadonlySet<string>> {
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (identity === null) return new Set();
  const live = await groupSkillPolicyRepository.loadGroupSkillAllowlist(identity.groupId);
  return new Set([...resolveExternalGroupSkillPolicy(auth)].filter((name) => live.has(name)));
}
