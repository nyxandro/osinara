/**
 * Owner-facing grant surface for external Telegram group capabilities.
 *
 * Exports:
 * - `GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES`: capabilities the owner can actually grant right now.
 * - `isGrantableExternalGroupToolName`: exact guard for model-provided allowlist items.
 * - `selectGrantableExternalGroupTools`: splits a persisted allowlist into effective and inert.
 *
 * Key constructs:
 * - Provider-coupled capabilities disappear from the grant contract instead of being granted inert.
 * - Persisted parsing stays in `group-tool-catalog.ts` so a stale grant never corrupts a policy.
 */
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  isSubscriptionOnlyExternalGroupToolName,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";


// Only subscription-backed image generation is provider-coupled today. Resolving the flag once at
// module load matches the validated runtime config, which cannot change without a process restart.
function isGrantableCapability(name: ExternalGroupToolName): boolean {
  return !isSubscriptionOnlyExternalGroupToolName(name) || IMAGE_GENERATION_AVAILABLE;
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
  /** Persisted entries that grant nothing now: provider-gated capabilities and unknown names. */
  readonly unavailable: readonly string[];
}

/**
 * A grant persisted under a previous provider stays in PostgreSQL but must never be presented as an
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
    if (isGrantableExternalGroupToolName(name)) effective.push(name);
    else unavailable.push(name);
  }
  return { effective, unavailable };
}
