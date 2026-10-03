/** Group networks must exclude the Docker host as well as other containers. */
import type Docker from "dockerode";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureGroupNetwork, removeUnusedGroupNetwork } from "./group-egress-network.js";
import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { sandboxRequestHash } from "./docker-sandbox-lifecycle.js";

function fixture(options: Record<string, string> = {}) {
  const info = {
    Driver: "bridge", Internal: true, EnableIPv6: false, Options: options,
    Labels: { "dev.osinara.group-egress.workspace": "workspace", "dev.osinara.group-egress.project": "test" },
    Containers: {},
  };
  const network = { inspect: vi.fn().mockResolvedValue(info), connect: vi.fn() };
  const docker = {
    getNetwork: vi.fn(() => network), createNetwork: vi.fn().mockResolvedValue(network),
    listContainers: vi.fn().mockResolvedValue([{ Id: "proxy" }]),
  };
  return { docker, network, info };
}

describe("external group network isolation", () => {
  it("retains a network referenced by a stopped group sandbox with no active endpoint", async () => {
    const { docker, network, info } = fixture({ "com.docker.network.bridge.gateway_mode_ipv4": "isolated" });
    info.Containers = { proxy: {} };
    const disconnect = vi.fn(), remove = vi.fn();
    Object.assign(network, { disconnect, remove });
    docker.listContainers.mockImplementation(async (options?: unknown) => {
      const filters = options as { all?: boolean; filters?: { label?: string[] } };
      return filters.filters?.label?.includes("dev.osinara.sandbox.group-workspace-id=workspace")
        ? [{ Id: "retained-stopped", State: "exited" }] : [{ Id: "proxy" }];
    });
    await removeUnusedGroupNetwork(docker as unknown as Docker, "test", "workspace");
    expect(docker.listContainers).toHaveBeenCalledWith({ all: true, filters: { label: [
      "dev.osinara.sandbox.project=test", "dev.osinara.sandbox.group-workspace-id=workspace",
    ] } });
    expect(disconnect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes a proxy-only network only after its last retained sandbox is gone", async () => {
    const { docker, network, info } = fixture({ "com.docker.network.bridge.gateway_mode_ipv4": "isolated" });
    info.Containers = { proxy: {} };
    const disconnect = vi.fn(), remove = vi.fn();
    Object.assign(network, { disconnect, remove });
    docker.listContainers.mockImplementation(async (options?: unknown) => {
      const filters = options as { filters?: { label?: string[] } };
      return filters.filters?.label?.includes("dev.osinara.sandbox.group-workspace-id=workspace") ? [] : [{ Id: "proxy" }];
    });
    await removeUnusedGroupNetwork(docker as unknown as Docker, "test", "workspace");
    expect(disconnect).toHaveBeenCalledWith({ Container: "proxy", Force: true });
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each([true, false])("connects a replacement proxy when reusing a group container (running: %s)", async (running) => {
    const root = await mkdtemp(join(tmpdir(), "osinara-group-network-"));
    try {
      const { docker, network, info } = fixture({ "com.docker.network.bridge.gateway_mode_ipv4": "isolated" });
      info.Containers = { "old-proxy": {} };
      docker.listContainers.mockResolvedValue([{ Id: "new-proxy" }]);
      const request = {
        access: "group-tools" as const, agentSessionId: "wrun_01JZ8K4R0W6G73VTHX9NF2QABC",
        mounts: [{ mountPoint: "group" as const, workspaceId: "workspace" }],
        sandboxSessionId: "session", seedDigest: "a".repeat(64),
      };
      const existing = { start: vi.fn(), inspect: vi.fn().mockResolvedValue({
        Id: "f".repeat(64), State: { Running: running }, Config: { Labels: {
          "dev.osinara.sandbox.request-hash": sandboxRequestHash(request),
          "dev.osinara.sandbox.session-id": "session",
        } },
      }) };
      const createContainer = vi.fn();
      const engine = createDockerSandboxEngine({
        docker: { ...docker, getContainer: () => existing, createContainer } as unknown as Docker,
        roots: { workspaceRoot: join(root, "workspaces"), toolsRoot: join(root, "tools") },
        runtime: { project: "test", image: "test-image", egressNetwork: "trusted", toolsVolume: "tools", workspaceVolume: "workspaces" },
      });
      await expect(engine.createSession(request)).resolves.toMatchObject({ created: false, instanceId: "f".repeat(64) });
      expect(createContainer).not.toHaveBeenCalled();
      expect(existing.start).toHaveBeenCalledTimes(running ? 0 : 1);
      expect(network.connect).toHaveBeenCalledWith({ Container: "new-proxy", EndpointConfig: { Aliases: ["sandbox-egress-proxy"] } });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("creates an isolated bridge without IPv6 and verifies it before connecting the proxy", async () => {
    const { docker, network } = fixture({ "com.docker.network.bridge.gateway_mode_ipv4": "isolated" });
    network.inspect.mockRejectedValueOnce({ statusCode: 404 });
    await ensureGroupNetwork(docker as unknown as Docker, "test", "workspace");
    expect(docker.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
      Internal: true, EnableIPv6: false,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    }));
    expect(network.connect).toHaveBeenCalledOnce();
  });

  it.each(["host-routable", "ipv6", "foreign-driver"])("rejects an existing %s network", async (variant) => {
    const { docker, network, info } = fixture({ "com.docker.network.bridge.gateway_mode_ipv4": "isolated" });
    if (variant === "host-routable") info.Options = {};
    if (variant === "ipv6") info.EnableIPv6 = true;
    if (variant === "foreign-driver") info.Driver = "overlay";
    await expect(ensureGroupNetwork(docker as unknown as Docker, "test", "workspace"))
      .rejects.toThrow("AGENT_SANDBOX_GROUP_NETWORK_INVALID");
    expect(network.connect).not.toHaveBeenCalled();
  });
});
