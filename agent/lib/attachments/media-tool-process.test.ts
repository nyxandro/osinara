/**
 * Tests of the bounded process that runs a media tool on an untrusted file.
 *
 * Constructs covered:
 * - `runMediaTool`: the tool's output, with `PATH` alone and, under root, as `nobody`; its input
 *   file as a descriptor the tool could not open itself.
 * - Refusals for a tool that runs too long, writes too much, fails, cannot start or is not installed.
 */
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MEDIA_TOOL_INPUT_FD, runMediaTool } from "./media-tool-process.js";

const NOBODY_UID = 65_534;
const limits = { maxOutputBytes: 1_024, timeoutMs: 5_000 };

afterEach(() => {
  delete process.env.OSINARA_MEDIA_TOOL_TEST_SECRET;
});

describe("runMediaTool", () => {
  it("returns what the tool wrote", async () => {
    const output = await runMediaTool({ ...limits, args: ["кадр"], binary: "/usr/bin/echo" });

    expect(output.toString("utf8")).toBe("кадр\n");
  });

  // An exploited decoder must find neither the agent's secrets nor its privileges.
  it("runs the tool without the agent's environment", async () => {
    process.env.OSINARA_MEDIA_TOOL_TEST_SECRET = "secret";

    const output = await runMediaTool({ ...limits, args: [], binary: "/usr/bin/env" });

    expect(output.toString("utf8")).toBe("PATH=/usr/local/bin:/usr/bin:/bin\n");
  });

  it("hands the tool its input file as a descriptor it could not open itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-media-tool-test-"));
    const path = join(directory, "input");
    await writeFile(path, "кадр", { mode: 0o600 });
    const handle = await open(path, "r");
    try {
      const output = await runMediaTool({
        ...limits,
        // The shell's own `read`: under a root agent the tool may start no other program.
        args: ["-c", `read -r line <&${MEDIA_TOOL_INPUT_FD}; printf %s "$line"`],
        binary: "/bin/sh",
        inputFd: handle.fd,
      });

      expect(output.toString("utf8")).toBe("кадр");
    } finally {
      await handle.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs the tool as nobody when the agent runs as root", async () => {
    const output = await runMediaTool({ ...limits, args: ["-u"], binary: "/usr/bin/id" });

    const uid = process.getuid?.();
    expect(output.toString("utf8").trim()).toBe(String(uid === 0 ? NOBODY_UID : uid));
  });

  it("stops a tool that runs too long", async () => {
    await expect(runMediaTool({ ...limits, args: ["5"], binary: "/usr/bin/sleep", timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_TIMEOUT" });
  });

  it("stops a tool that writes more than allowed", async () => {
    await expect(runMediaTool({ ...limits, args: [], binary: "/usr/bin/yes" }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_OUTPUT_TOO_LARGE" });
  });

  it("reports a tool that fails with its exit code", async () => {
    await expect(runMediaTool({ ...limits, args: [], binary: "/usr/bin/false" }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_FAILED", details: { exitCode: 1 } });
  });

  it("never takes a line the tool wrote itself for a failure of the sandbox", async () => {
    await expect(runMediaTool({
      ...limits,
      args: ["-c", "echo 'media-sandbox: enforcing the Landlock ruleset: Operation not permitted (EPERM)' >&2; exit 120"],
      binary: "/bin/sh",
    })).rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_FAILED", details: { exitCode: 120 } });
  });

  it("reports a tool that is not installed", async () => {
    await expect(runMediaTool({ ...limits, args: [], binary: "/usr/local/bin/osinara-missing-tool" }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_MISSING" });
  });

  it("reports a tool that cannot start apart from one that failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-media-tool-test-"));
    const path = join(directory, "not-executable");
    await writeFile(path, "#!/bin/sh\n", { mode: 0o644 });
    try {
      await expect(runMediaTool({ ...limits, args: [], binary: path }))
        .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_START_FAILED", details: { errno: "EACCES" } });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

// A root or production agent runs every tool inside `media-sandbox` (services/media-sandbox/):
// Landlock and seccomp. The test image is such an agent; a development machine runs the tool as itself.
const SANDBOXED = process.getuid?.() === 0 || process.env.NODE_ENV === "production";

(SANDBOXED ? describe : describe.skip)("runMediaTool in the sandbox", () => {
  it("keeps the tool from every file, even one any user may read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-media-tool-test-"));
    const path = join(directory, "family-note.txt");
    await writeFile(path, "семейная заметка", { mode: 0o644 });
    await chmod(directory, 0o755);
    try {
      await expect(runMediaTool({ ...limits, args: ["-c", `read -r line < ${path} && printf %s "$line"`], binary: "/bin/sh" }))
        .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_FAILED", details: { stderr: expect.stringContaining("Permission denied") } });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps the tool off every network", async () => {
    await expect(runMediaTool({ ...limits, args: ["-c", "exec 4<>/dev/tcp/127.0.0.1/9"], binary: "/usr/bin/bash" }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_FAILED", details: { stderr: expect.stringContaining("socket: Permission denied") } });
  });

  it("lets the tool write nothing and start no other program", async () => {
    await expect(runMediaTool({ ...limits, args: ["-c", "printf x > /tmp/osinara-media-tool-written"], binary: "/bin/sh" }))
      .rejects.toMatchObject({ details: { stderr: expect.stringContaining("Permission denied") } });
    await expect(runMediaTool({ ...limits, args: ["-c", "exec /usr/bin/id -u"], binary: "/usr/bin/bash" }))
      .rejects.toMatchObject({ details: { stderr: expect.stringContaining("Permission denied") } });
  });

  it("lets the tool start threads but no other process, which could hold its output open", async () => {
    await expect(runMediaTool({ ...limits, args: ["-c", "( sleep 30 ) & wait"], binary: "/usr/bin/bash" }))
      .rejects.toMatchObject({ code: "AGENT_MEDIA_TOOL_FAILED", details: { stderr: expect.stringContaining("fork") } });
  });

  it("finds a tool named without a path in its PATH", async () => {
    const output = await runMediaTool({ ...limits, args: ["кадр"], binary: "echo" });

    expect(output.toString("utf8")).toBe("кадр\n");
  });
});

