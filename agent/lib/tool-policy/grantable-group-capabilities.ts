/**
 * Owner-facing grant surface for external Telegram group capabilities.
 *
 * Exports:
 * - `GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES`: capabilities the owner can actually grant.
 * - `isGrantableExternalGroupToolName`: exact guard for model-provided allowlist items.
 * - `selectGrantableExternalGroupTools`: splits a persisted allowlist into effective and inert.
 *
 * Key constructs:
 * - Baseline access is never offered as a grant; a persisted one stays parseable and inert.
 * - Persisted parsing stays in `group-tool-catalog.ts` so a stale grant never corrupts a policy.
 */
import {
  BASELINE_EXTERNAL_GROUP_GRANTS,
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  isExternalGroupToolName,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

/**
 * Non-empty tuple shape keeps the derived list usable as a Zod enum while the filter keeps the model
 * contract honest: a capability absent here has no descriptor the owner could target.
 */
export const GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES: readonly [
  ExternalGroupToolName,
  ...ExternalGroupToolName[],
] = EXTERNAL_GROUP_CAPABILITY_CATALOG
  .map(({ name }) => name)
  .filter((name) => !BASELINE_EXTERNAL_GROUP_GRANTS.has(name)) as [ExternalGroupToolName, ...ExternalGroupToolName[]];

export function isGrantableExternalGroupToolName(
  value: string,
): value is ExternalGroupToolName {
  return (GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES as readonly string[]).includes(value);
}

export interface GrantableExternalGroupToolSelection {
  /** Persisted grants the owner can re-submit. */
  readonly effective: readonly ExternalGroupToolName[];
  /** Persisted entries that grant nothing: unknown names. */
  readonly unavailable: readonly string[];
}

/**
 * An unrecognized persisted name is reported rather than hidden: `parseExternalGroupToolAllowlist`
 * treats it as corruption of the whole policy, so a silently trimmed status would look healthy while
 * the group is actually denied every capability.
 */
export function selectGrantableExternalGroupTools(
  persisted: readonly string[],
): GrantableExternalGroupToolSelection {
  const effective: ExternalGroupToolName[] = [];
  const unavailable: string[] = [];
  for (const name of persisted) {
    // A saved grant that became baseline access is no unavailable service either.
    if (isExternalGroupToolName(name) && BASELINE_EXTERNAL_GROUP_GRANTS.has(name)) continue;
    if (isGrantableExternalGroupToolName(name)) effective.push(name);
    else unavailable.push(name);
  }
  return { effective, unavailable };
}
