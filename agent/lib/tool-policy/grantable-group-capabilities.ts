/**
 * Owner-facing grant surface for external Telegram group capabilities.
 *
 * Exports:
 * - `isServableExternalGroupCapability`, `servableExternalGroupCapabilities`,
 *   `parseServableExternalGroupToolAllowlist`: what the active runtime can actually serve out of a
 *   persisted grant.
 * - `unservableCapabilityReason`: the owner-facing reason a capability cannot work right now.
 * - `GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES`: capabilities the owner can actually grant right now.
 * - `isGrantableExternalGroupToolName`: exact guard for model-provided allowlist items.
 * - `selectGrantableExternalGroupTools`: splits a persisted allowlist into effective and inert.
 *
 * Key constructs:
 * - Runtime-coupled capabilities disappear from the grant contract instead of being granted inert.
 * - Persisted parsing stays in `group-tool-catalog.ts` so a stale grant never corrupts a policy.
 */
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { MODEL_VISION_AVAILABLE } from "../model-vision-availability.js";
import {
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  externalGroupCapabilityRequirement,
  parseExternalGroupToolAllowlist,
  type ExternalGroupCapabilityRequirement,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

// Both flags come from the validated runtime config, which cannot change without a process restart.
const REQUIREMENT_SATISFIED: Readonly<Record<ExternalGroupCapabilityRequirement, boolean>> = {
  image_generation: IMAGE_GENERATION_AVAILABLE,
  vision: MODEL_VISION_AVAILABLE,
};

export function isServableExternalGroupCapability(name: ExternalGroupToolName): boolean {
  const requirement = externalGroupCapabilityRequirement(name);
  return requirement === null || REQUIREMENT_SATISFIED[requirement];
}

const UNSERVABLE_REASONS: Readonly<Record<ExternalGroupCapabilityRequirement, string>> = {
  image_generation: "текущая модель агента работает не через подписку OpenAI Codex",
  vision: "подключённая модель агента не видит изображения",
};

/** Why a catalog capability cannot work in this runtime, or `null` when it can. */
export function unservableCapabilityReason(name: ExternalGroupToolName): string | null {
  const requirement = externalGroupCapabilityRequirement(name);
  return requirement === null || REQUIREMENT_SATISFIED[requirement] ? null : UNSERVABLE_REASONS[requirement];
}

/**
 * A grant persisted under a runtime that could serve it stays in PostgreSQL, but it must give the
 * current turn no descriptor, guidance, intake or execution right.
 */
export function servableExternalGroupCapabilities(
  allowed: ReadonlySet<ExternalGroupToolName>,
): ReadonlySet<ExternalGroupToolName> {
  return new Set([...allowed].filter(isServableExternalGroupCapability));
}

/** A persisted allowlist as the current runtime can serve it; `null` still marks a corrupt policy. */
export function parseServableExternalGroupToolAllowlist(
  value: unknown,
): ReadonlySet<ExternalGroupToolName> | null {
  const allowed = parseExternalGroupToolAllowlist(value);
  return allowed === null ? null : servableExternalGroupCapabilities(allowed);
}

function isGrantableCapability(name: ExternalGroupToolName): boolean {
  return name !== "web_fetch" && isServableExternalGroupCapability(name);
}

/**
 * Non-empty tuple shape keeps the derived list usable as a Zod enum while the runtime filter keeps
 * the model contract honest: a capability absent here has no descriptor the owner could target.
 */
export const GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES: readonly [
  ExternalGroupToolName,
  ...ExternalGroupToolName[],
] = EXTERNAL_GROUP_CAPABILITY_CATALOG
  .map(({ name }) => name)
  .filter(isGrantableCapability) as [ExternalGroupToolName, ...ExternalGroupToolName[]];

export function isGrantableExternalGroupToolName(
  value: string,
): value is ExternalGroupToolName {
  return (GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES as readonly string[]).includes(value);
}

export interface GrantableExternalGroupToolSelection {
  /** Persisted grants that the current runtime can still honour and the owner can re-submit. */
  readonly effective: readonly ExternalGroupToolName[];
  /** Persisted entries that grant nothing now: runtime-gated capabilities and unknown names. */
  readonly unavailable: readonly string[];
}

/**
 * A grant persisted under a previous runtime stays in PostgreSQL but must never be presented as an
 * active right, otherwise the owner-facing status would invite a policy update that fails closed.
 * An unrecognized persisted name is reported too rather than hidden: `parseExternalGroupToolAllowlist`
 * treats it as corruption of the whole policy, so a silently trimmed status would look healthy while
 * the group is actually denied every capability.
 */
export function selectGrantableExternalGroupTools(
  persisted: readonly string[],
): GrantableExternalGroupToolSelection {
  const effective: ExternalGroupToolName[] = [];
  const unavailable: string[] = [];
  for (const name of persisted) {
    // Existing saved grants for page reading became baseline access, not an unavailable service.
    if (name === "web_fetch") continue;
    if (isGrantableExternalGroupToolName(name)) effective.push(name);
    else unavailable.push(name);
  }
  return { effective, unavailable };
}
