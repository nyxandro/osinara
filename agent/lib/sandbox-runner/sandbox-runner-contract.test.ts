/**
 * Sandbox runner trust-boundary contract tests.
 *
 * Constructs covered:
 * - Trusted personal/family mount validation.
 * - Restricted external-group mount validation.
 * - Duplicate and mixed-scope rejection.
 */
import { describe, expect, it } from "vitest";

import { parseCreateSandboxRequest } from "./sandbox-runner-contract.js";

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const BACKEND_SESSION_ID =
  "eve-sbx-ses-osinara-scoped-runner-local-a1b2c3d4e5f6-wrun_01JZ8K4R0W6G73VTHX9NF2QABC-__root__";

describe("parseCreateSandboxRequest", () => {
  it("accepts trusted personal and family mounts with persistent tools", () => {
    expect(parseCreateSandboxRequest({
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sessionId: BACKEND_SESSION_ID,
    })).toEqual({
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sessionId: BACKEND_SESSION_ID,
    });
  });

  it("accepts only a group mount for a restricted session", () => {
    expect(parseCreateSandboxRequest({
      access: "restricted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sessionId: BACKEND_SESSION_ID,
    })).toMatchObject({ access: "restricted" });
  });

  it.each([
    {
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABE",
    },
    {
      access: "restricted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID }],
      sessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABF",
    },
    {
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABG",
    },
  ])("rejects an invalid scope combination", (request) => {
    expect(() => parseCreateSandboxRequest(request)).toThrowError(
      /AGENT_SANDBOX_RUNNER_SCOPE_INVALID/,
    );
  });
});
