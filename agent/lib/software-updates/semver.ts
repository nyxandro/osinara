/**
 * Strict SemVer 2.0 parsing and precedence for software updates.
 *
 * Exports:
 * - `parseSemver`: validates and decomposes one complete semantic version.
 * - `compareSemver`: compares two semantic versions by SemVer precedence.
 * - `stableVersionFromTag`: accepts only exact stable `vX.Y.Z` release tags.
 */
import { AppError } from "../app-error.js";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const STABLE_RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER_MAX_LENGTH = 128;

export interface ParsedSemver {
  build: readonly string[];
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
  version: string;
}

export function parseSemver(version: string): ParsedSemver {
  const match = version.length <= SEMVER_MAX_LENGTH ? SEMVER_PATTERN.exec(version) : null;
  if (!match) {
    throw new AppError(
      "AGENT_SOFTWARE_VERSION_INVALID",
      `Версия программы «${version}» не соответствует формату SemVer`,
    );
  }
  return {
    build: match[5]?.split(".") ?? [],
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split(".") ?? [],
    version,
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  // Numeric identifiers compare numerically and always precede non-numeric identifiers.
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareSemver(leftVersion: string, rightVersion: string): -1 | 0 | 1 {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] === right[field]) continue;
    return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function stableVersionFromTag(tag: string): string | null {
  const match = tag.length <= SEMVER_MAX_LENGTH ? STABLE_RELEASE_TAG_PATTERN.exec(tag) : null;
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}
