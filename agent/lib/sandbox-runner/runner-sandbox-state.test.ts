/**
 * Persisted sandbox backend state validation tests.
 *
 * Constructs covered:
 * - Existing mounted metadata without the new discriminator remains readable.
 * - Disabled metadata cannot smuggle a workspace mount into an internal session.
 */
import { describe, expect, it } from "vitest";

import { parseStoredSandboxMetadata } from "./runner-sandbox-state.js";

const AGENT_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const STATE_SCHEMA_VERSION = 3;

describe("persisted sandbox state", () => {
  it("accepts the existing mounted metadata shape", () => {
    expect(parseStoredSandboxMetadata({
      access: "trusted",
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    }, AGENT_SESSION_ID, STATE_SCHEMA_VERSION)).toEqual({
      access: "trusted",
      disabled: false,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    });
  });

  it("accepts an explicitly disabled state without mounts", () => {
    expect(parseStoredSandboxMetadata({
      disabled: true,
      mounts: [],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    }, AGENT_SESSION_ID, STATE_SCHEMA_VERSION)).toEqual({
      disabled: true,
      mounts: [],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    });
  });

  it("rejects a workspace mount hidden inside disabled metadata", () => {
    expect(() => parseStoredSandboxMetadata({
      disabled: true,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    }, AGENT_SESSION_ID, STATE_SCHEMA_VERSION)).toThrowError(
      /AGENT_SANDBOX_RUNNER_STATE_INVALID/,
    );
  });

  it("rejects reconnect metadata from another state schema", () => {
    expect(() => parseStoredSandboxMetadata({
      disabled: true,
      mounts: [],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION - 1,
    }, AGENT_SESSION_ID, STATE_SCHEMA_VERSION)).toThrowError(
      /AGENT_SANDBOX_RUNNER_STATE_INVALID: Reconnect schema mismatch/,
    );
  });

  it("rejects a non-boolean disabled discriminator", () => {
    expect(() => parseStoredSandboxMetadata({
      access: "trusted",
      disabled: "true",
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: STATE_SCHEMA_VERSION,
    }, AGENT_SESSION_ID, STATE_SCHEMA_VERSION)).toThrowError(
      /AGENT_SANDBOX_RUNNER_STATE_INVALID: Sandbox state discriminator is malformed/,
    );
  });
});
