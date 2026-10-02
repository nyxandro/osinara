/**
 * External Telegram group policy projection from verified Eve auth.
 *
 * Exports:
 * - `resolveExternalGroupToolPolicy`: reads a fail-closed capability snapshot from session auth.
 * - `resolveExternalGroupPolicyIdentity`: reads the verified family/group policy key.
 *
 * This module holds no tool definitions, so prompt assembly can read the policy without importing
 * the whole executable tool surface.
 */
import type { SessionAuth } from "../../runtime/context.js";

import {
  type GroupSafeSkillName,
  parseGroupSkillAllowlist,
} from "../group-skills/group-skill-catalog.js";
import {
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

interface RestrictedGroupToolPolicy {
  allowed: ReadonlySet<ExternalGroupToolName>;
  restricted: true;
}

export type GroupToolPolicy = RestrictedGroupToolPolicy | { restricted: false };

function isExternalPrincipal(principal: SessionAuth["current"]): boolean {
  return principal?.attributes.groupType === "external";
}

function externalPolicyCaller(auth: SessionAuth): SessionAuth["current"] {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return null;

  // An external initiator permanently taints a resumed session. A present current principal may
  // replace its policy only when it proves the same external trust zone; every conflict denies all.
  if (initiatorExternal && auth.current) {
    const sameGroup = auth.current.attributes.groupId === auth.initiator?.attributes.groupId;
    return currentExternal && sameGroup ? auth.current : null;
  }
  if (!auth.current && initiatorExternal) return auth.initiator;
  return auth.current;
}

export function resolveExternalGroupPolicyIdentity(auth: SessionAuth): {
  familyId: string;
  groupId: string;
} | null {
  const caller = externalPolicyCaller(auth);
  const familyId = caller?.attributes.familyId;
  const groupId = caller?.attributes.groupId;
  return typeof familyId === "string" && typeof groupId === "string"
    ? { familyId, groupId }
    : null;
}

export function resolveExternalGroupToolPolicy(auth: SessionAuth): GroupToolPolicy {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return { restricted: false };

  const caller = externalPolicyCaller(auth);
  const allowed = caller ? parseExternalGroupToolAllowlist(caller.attributes.toolAllowlist) : null;

  // Corrupt or incomplete trusted policy must deny everything rather than widen the surface.
  return {
    allowed: allowed ?? new Set(),
    restricted: true,
  };
}

export function resolveExternalGroupSkillPolicy(
  auth: SessionAuth,
): ReadonlySet<GroupSafeSkillName> {
  const caller = externalPolicyCaller(auth);
  return caller
    ? parseGroupSkillAllowlist(caller.attributes.skillAllowlist) ?? new Set<GroupSafeSkillName>()
    : new Set<GroupSafeSkillName>();
}
