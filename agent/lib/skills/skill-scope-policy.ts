/**
 * Fail-closed scope policy for dynamic skills with persistent trusted state.
 *
 * Exports:
 * - `TrustedSkillScope`: personal and family scopes that may own tool state.
 * - `SkillScopePolicy`: explicit per-skill allowed-scope declaration.
 * - `defineSkillScopePolicy`: validates and freezes a reusable skill policy flag.
 * - `resolveAllowedSkillScope`: resolves the current verified Telegram scope.
 */
import type { SessionAuth } from "eve/context";

export type TrustedSkillScope = "family" | "personal";

export interface SkillScopePolicy {
  readonly allowedScopes: readonly TrustedSkillScope[];
}

const FAMILY_ROLES = new Set(["member", "owner", "recovery_owner"]);

export function defineSkillScopePolicy(input: SkillScopePolicy): SkillScopePolicy {
  // Invalid declarations are deployment defects, so reject them before any skill can be exposed.
  const allowedScopes = [...input.allowedScopes];
  if (allowedScopes.length === 0 || new Set(allowedScopes).size !== allowedScopes.length) {
    throw new Error(
      "AGENT_SKILL_SCOPE_POLICY_INVALID: Allowed scopes must be non-empty and unique",
    );
  }
  return Object.freeze({ allowedScopes: Object.freeze(allowedScopes) });
}

function resolveCurrentScope(auth: SessionAuth): TrustedSkillScope | null {
  const caller = auth.current;
  const attributes = caller?.attributes;
  const chatType = attributes?.telegramChatType;
  const role = attributes?.role;

  // Only the fresh Telegram user identity may select a persistent skill scope.
  if (
    caller?.authenticator !== "telegram" ||
    caller.principalType !== "user" ||
    typeof attributes?.familyId !== "string" ||
    !FAMILY_ROLES.has(String(role))
  ) {
    return null;
  }

  // A private chat always owns personal state; external or malformed group metadata cannot cross in.
  if (chatType === "private") {
    const groupType = attributes.groupType;
    return groupType === undefined || groupType === null ? "personal" : null;
  }

  // Family state exists only in the registered closed family trust zone.
  const familyGroup =
    (chatType === "group" || chatType === "supergroup") &&
    attributes.groupType === "family_private" &&
    typeof attributes.groupId === "string";
  return familyGroup ? "family" : null;
}

export function resolveAllowedSkillScope(
  auth: SessionAuth,
  policy: SkillScopePolicy,
): TrustedSkillScope | null {
  const scope = resolveCurrentScope(auth);
  return scope && policy.allowedScopes.includes(scope) ? scope : null;
}
