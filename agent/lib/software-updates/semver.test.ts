/**
 * Software update semantic-version tests.
 *
 * Constructs covered:
 * - Stable and prerelease SemVer precedence without lexicographic shortcuts.
 * - Strict stable GitHub release tags and invalid-version rejection.
 */
import { describe, expect, it } from "vitest";

import {
  compareSemver,
  parseSemver,
  stableVersionFromTag,
} from "./semver.js";

describe("software update semantic versions", () => {
  it.each([
    ["0.1.0", "0.1.1", -1],
    ["1.9.9", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0+build.1", "1.0.0+build.2", 0],
  ] as const)("compares %s with %s", (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected);
  });

  it.each(["01.2.3", "1.2", "v1.2.3", "1.2.3-", "1.2.3+bad value"])(
    "rejects invalid SemVer %s",
    (version) => {
      expect(() => parseSemver(version)).toThrowError(/AGENT_SOFTWARE_VERSION_INVALID/);
    },
  );

  it("accepts only stable vX.Y.Z release tags", () => {
    expect(stableVersionFromTag("v12.34.56")).toBe("12.34.56");
    expect(stableVersionFromTag("12.34.56")).toBeNull();
    expect(stableVersionFromTag("v1.2.3-rc.1")).toBeNull();
    expect(stableVersionFromTag("v01.2.3")).toBeNull();
  });
});
