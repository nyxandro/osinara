/**
 * The skills of one turn: the release's built-in skills plus the family's own ones this conversation has.
 *
 * Exports:
 * - `resolveConversationSkills`: a private chat gets every built-in skill and the family skills its
 *   person enabled for themselves; a family group gets every built-in skill and the family skills on
 *   its list; an external group gets the skills of its verified list that still exist. Every zone also
 *   gets the service skills of the tools in the turn's surface (`service-skills.ts`). A guest's private chat
 *   (#471) loses the skills the owner turned off for that guest, and a removed guest's has none. It also gets
 *   the skills of the owner's library given to that guest (#474), read from the host family; the guest's own
 *   skill of the same name wins.
 *
 * The family's skills are read from the database on every turn, so a change takes effect from the
 * next turn without a new context. A built-in skill keeps its name if a family skill with the same
 * name appears later.
 */
import type { SessionAuth } from "../../runtime/context.js";
import type { SkillDefinition } from "../../runtime/skills/definition.js";
import { AppError } from "../app-error.js";
import { resolveConversationEnvironment, type ConversationEnvironment } from "../conversation-environment.js";
import { isFamilyOwner } from "../family-context.js";
import { familySkillRepository, type FamilySkillSelection } from "../family-skills/family-skill-repository.js";
import { serviceSkillsFor } from "../family-skills/service-skills.js";
import { guestPolicyFor, type SessionGuest } from "../guests/guest-policy.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupSkillPolicy,
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
  turn: { readonly toolNames: ReadonlySet<string> },
): Promise<Record<string, SkillDefinition>> {
  const environment = resolveConversationEnvironment(auth);
  // A private question (`/me`, #467) runs no scripts and reads no files: only the how-to of its own tools.
  if (auth.current?.attributes.privateQuestion === "true") return serviceSkillsFor(environment, turn.toolNames);
  const guest = environment === "private" && !isFamilyOwner(auth) ? await guestPolicyFor(auth) : null;
  if (guest !== null && !guest.policy.active) return {};
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
  const skills = {
    ...Object.fromEntries(names.flatMap((name) => catalog[name] === undefined ? [] : [[name, catalog[name]]])),
    ...await hostSkillsGivenTo(guest, new Set(names)),
    ...serviceSkillsFor(environment, turn.toolNames),
  };
  return guest === null
    ? skills
    : Object.fromEntries(Object.entries(skills).filter(([name]) => !guest.policy.disabledSkills.has(name)));
}

/**
 * The owner's library skills given to a guest, less a name the guest's chat already has. What is given is read again
 * with the skills themselves, in one statement: the policy read before it only says whether to look.
 */
async function hostSkillsGivenTo(guest: SessionGuest | null, taken: ReadonlySet<string>): Promise<Record<string, SkillDefinition>> {
  if (guest === null || guest.policy.grantedSkills.size === 0) return {};
  const given = await familySkillRepository.loadWorking(guest.policy.hostFamilyId, { givenToGuestFamily: guest.familyId });
  return Object.fromEntries(Object.entries(given).filter(([name]) => !taken.has(name)));
}
