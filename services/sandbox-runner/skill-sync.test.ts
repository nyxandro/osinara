import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncSkillFiles, syncSandboxSkills } from "./skill-sync.js";
import { createSandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";
import { executeSandboxProcess } from "./docker-sandbox-process.js";
vi.mock("./docker-sandbox-process.js", () => ({ executeSandboxProcess: vi.fn() }));
const request = { expectedInstanceId: "a".repeat(64), keep: ["test"], packages: [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "cmV2aWV3ZWQ=" }] }] };
beforeEach(() => vi.mocked(executeSandboxProcess).mockReset().mockResolvedValue({ exitCode: 0, stdout: '{"checked":1,"written":1,"removed":0}', stderr: "", processId: "test" }));

describe("skill synchronization execution boundary", () => {
  it("holds the session lifecycle lock until an active synchronization has finished", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(executeSandboxProcess).mockImplementation(async () => { await gate; return { exitCode: 0, stdout: '{"checked":1,"written":1,"removed":0}', stderr: "", processId: "test" }; });
    const activity = createSandboxActivityRegistry(Date.now);
    const container = { inspect: vi.fn(async () => ({ Id: request.expectedInstanceId, State: { Running: true }, HostConfig: {},
      Config: { Labels: { "dev.osinara.sandbox.session-id": "session", "dev.osinara.sandbox.project": "test", "dev.osinara.sandbox.access": "restricted" } },
    })) };
    const work = syncSandboxSkills({ docker: { getContainer: () => container } as never, activity,
      toolsRoot: "/unused", toolsVolume: "test-tools", project: "test" }, "session", request);
    const stop = vi.fn(); let stopped: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(executeSandboxProcess).toHaveBeenCalledOnce());
      stopped = activity.runExclusive("session", stop);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(stop).not.toHaveBeenCalled();
    } finally { finish(); await work; await stopped; }
    expect(stop).toHaveBeenCalledOnce();
  });
  it("does not run queued work after cancellation or in a replacement container", async () => {
    for (const reason of ["cancel", "replaced"] as const) {
      vi.mocked(executeSandboxProcess).mockClear();
      const activity = createSandboxActivityRegistry(Date.now);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const occupied = activity.runExclusive(`skills:container:${request.expectedInstanceId}`, () => gate);
      let id = request.expectedInstanceId;
      const container = { start: vi.fn(), inspect: vi.fn(async () => ({ Id: id, State: { Running: true }, HostConfig: {},
        Config: { Labels: { "dev.osinara.sandbox.session-id": "session", "dev.osinara.sandbox.project": "test", "dev.osinara.sandbox.access": "restricted" } },
      })) };
      const controller = new AbortController(), error = new Error("cancelled");
      const work = syncSandboxSkills({ docker: { getContainer: () => container } as never, activity,
        toolsRoot: "/unused", toolsVolume: "test-tools", project: "test" }, "session", request, controller.signal);
      await vi.waitFor(() => expect(container.inspect).toHaveBeenCalledOnce());
      if (reason === "cancel") controller.abort(error); else id = "b".repeat(64);
      const rejected = expect(work).rejects.toThrow(reason === "cancel" ? "cancelled" : "AGENT_SANDBOX_RUNNER_INSTANCE_STALE");
      release(); await occupied; await rejected;
      expect(container.start).not.toHaveBeenCalled(); expect(executeSandboxProcess).not.toHaveBeenCalled();
    }
  });
  it("checks a writable tools volume outside the model-controlled container", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "osinara-skill-host-"));
    try {
      const result = await syncSkillFiles({} as never, {} as never, request, { kind: "volume", homeRoot });
      expect(executeSandboxProcess).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 1, written: 1, removed: 0 });
      expect(await readFile(join(homeRoot, ".agents/skills/test/SKILL.md"), "utf8")).toBe("reviewed");
    } finally { await rm(homeRoot, { recursive: true, force: true }); }
  });
  it("uses the image's absolute interpreter only for the restricted container", async () => {
    const controller = new AbortController();
    await syncSkillFiles({} as never, {} as never, request, { kind: "container" }, controller.signal);
    expect(executeSandboxProcess).toHaveBeenCalledWith({}, {}, expect.objectContaining({
      command: expect.stringMatching(/^\/usr\/local\/bin\/node -e /u), stdin: expect.any(Buffer), timeoutMs: 60_000,
    }), controller.signal);
  });
  it("does not start work after HTTP cancellation", async () => {
    const controller = new AbortController(), error = new Error("cancelled by caller"); controller.abort(error);
    await expect(syncSkillFiles({} as never, {} as never, request, { kind: "container" }, controller.signal)).rejects.toBe(error);
    expect(executeSandboxProcess).not.toHaveBeenCalled();
  });
});
