/**
 * Docker sandbox isolation option tests.
 *
 * Constructs covered:
 * - Scoped volume-subpath mounts for canonical workspace and persistent tools.
 * - Public-only proxy egress for trusted sessions.
 * - Network-less, tool-less external-group containers.
 * - Resource, capability, and privilege restrictions.
 */
import { describe, expect, it } from "vitest";

import { buildSandboxContainerOptions } from "./docker-sandbox-engine.js";

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

describe("buildSandboxContainerOptions", () => {
  it("mounts only selected workspaces and their persistent tool directories", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABC",
    });

    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/personal",
        VolumeOptions: { Subpath: PERSONAL_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/family",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.toolsVolume,
        Target: "/tools/personal",
        VolumeOptions: { Subpath: PERSONAL_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.toolsVolume,
        Target: "/tools/family",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
    ]);
    expect(options.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      NetworkMode: runtime.egressNetwork,
      PidsLimit: 256,
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges:true"],
    });
    expect(options.Labels).toMatchObject({ "dev.osinara.sandbox.project": "osinara" });
    expect(options.Env).toEqual(expect.arrayContaining([
      "HOME=/tools/personal/home",
      "HTTPS_PROXY=http://sandbox-egress-proxy:3128",
      "NPM_CONFIG_PREFIX=/tools/personal/npm",
    ]));
  });

  it("gives an external group no tools volume and no network", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "restricted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABD",
    });

    expect(options.HostConfig?.NetworkMode).toBe("none");
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/group",
        VolumeOptions: { Subpath: GROUP_WORKSPACE_ID },
      }),
    ]);
    expect(options.Env).not.toEqual(expect.arrayContaining([
      expect.stringContaining("PROXY="),
      expect.stringContaining("/tools/"),
    ]));
  });
});
