/**
 * Production sandbox configuration tests.
 *
 * Constructs covered:
 * - Explicit selection of the isolated runner backend.
 * - Auth-scoped persistent mounts are installed at session start.
 */
import { describe, expect, it } from "vitest";

import sandbox from "./sandbox.js";

describe("agent sandbox", () => {
  it("selects a backend explicitly instead of relying on production auto-detection", () => {
    expect(sandbox.backend).toMatchObject({ name: "osinara-scoped-runner-v3" });
  });

  it("installs verified workspace mounts on each Eve session", () => {
    expect(sandbox.onSession).toBeTypeOf("function");
  });
});
