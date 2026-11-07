/**
 * Sandbox runner trust-boundary contract tests.
 *
 * Constructs covered:
 * - Trusted personal/family mount validation.
 * - Restricted external-group mount validation.
 * - Duplicate, mixed-scope, and unsafe seed-path rejection.
 * - A network of its own only for a trusted personal sandbox (a guest's, #471).
 */
import { describe, expect, it } from "vitest";

import {
  parseCreateSandboxRequest,
  sandboxSeedDigest,
} from "./sandbox-runner-contract.js";

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPTY_SEED_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("parseCreateSandboxRequest", () => {
  it("accepts trusted personal and family mounts with persistent tools", () => {
    expect(parseCreateSandboxRequest({
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    })).toEqual({
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    });
  });

  it("gives a network of its own only to a trusted personal sandbox", () => {
    const personal = { mountPoint: "personal" as const, workspaceId: PERSONAL_WORKSPACE_ID };
    const base = { agentSessionId: AGENT_SESSION_ID, sandboxSessionId: SANDBOX_SESSION_ID, seedDigest: EMPTY_SEED_DIGEST };

    expect(parseCreateSandboxRequest({ ...base, access: "trusted", mounts: [personal], ownNetwork: true }))
      .toMatchObject({ ownNetwork: true });
    expect(() => parseCreateSandboxRequest({
      ...base, access: "trusted", mounts: [{ mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID }], ownNetwork: true,
    })).toThrow(/Own network requires a trusted personal sandbox/u);
    expect(() => parseCreateSandboxRequest({
      ...base, access: "group-tools", mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }], ownNetwork: true,
    })).toThrow(/Own network requires a trusted personal sandbox/u);
    // The field is required: a request that does not say which network it wants is refused.
    expect(() => parseCreateSandboxRequest({ ...base, access: "trusted", mounts: [personal] })).toThrow(/ownNetwork/u);
  });

  it("accepts only a group mount for a restricted session", () => {
    expect(parseCreateSandboxRequest({
      access: "restricted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    })).toMatchObject({ access: "restricted" });
  });

  it.each([
    {
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    },
    {
      access: "restricted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    },
    {
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    },
  ])("rejects an invalid scope combination", (request) => {
    expect(() => parseCreateSandboxRequest(request)).toThrowError(
      /AGENT_SANDBOX_RUNNER_SCOPE_INVALID/,
    );
  });

  it("rejects seed files outside sandbox data roots", () => {
    const seedFiles = [
      { contentBase64: "c2VjcmV0", path: "/credentials/google-workspace/credentials.json" },
    ];
    expect(() => parseCreateSandboxRequest({
      access: "restricted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: sandboxSeedDigest(seedFiles),
      seedFiles,
    })).toThrowError(/AGENT_SANDBOX_RUNNER_SCOPE_INVALID/);
  });

  // Docker unpacks the seed archive at the container root, so a path must never step out of its root.
  it.each([
    "/workspace/../etc/cron.d/job",
    "/workspace/./notes.md",
    "/workspace//notes.md",
  ])("rejects a seed path that is not canonical: %s", (path) => {
    const seedFiles = [{ contentBase64: "c2VjcmV0", path }];
    expect(() => parseCreateSandboxRequest({
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: sandboxSeedDigest(seedFiles),
      seedFiles,
    })).toThrowError(/AGENT_SANDBOX_RUNNER_SCOPE_INVALID/);
  });

  it("accepts the same seed file at its canonical path", () => {
    const seedFiles = [{ contentBase64: "c2VjcmV0", path: "/workspace/notes.md" }];
    expect(parseCreateSandboxRequest({
      access: "trusted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: sandboxSeedDigest(seedFiles),
      seedFiles,
    }).seedFiles).toEqual(seedFiles);
  });

  it("rejects a mismatched digest and trusted tool paths in a restricted sandbox", () => {
    const seedFiles = [{ contentBase64: "c2tpbGw=", path: "/tools/personal/skill.md" }];
    expect(() => parseCreateSandboxRequest({
      access: "restricted",
      ownNetwork: false,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
      seedFiles,
    })).toThrowError(/AGENT_SANDBOX_RUNNER_SCOPE_INVALID/);
  });
});
