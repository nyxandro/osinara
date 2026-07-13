/**
 * Eve dynamic external-group tool policy tests.
 *
 * Constructs covered:
 * - `group-tool-policy`: step-scoped dynamic overrides derived from verified auth.
 */
import { describe, expect, it } from "vitest";

import groupToolPolicy from "../../tools/group-tool-policy.js";

describe("dynamic group tool policy", () => {
  it("returns no overrides outside an external group", async () => {
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: { auth: { current: null, initiator: null }, id: "session-1" },
    });

    expect(result).toBeNull();
  });

  it("returns fail-closed overrides for an external group", async () => {
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              groupType: "external_public",
              role: "external",
              toolAllowlist: [],
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    });

    expect(result).toMatchObject({ bash: expect.any(Object), remember: expect.any(Object) });
  });
});
