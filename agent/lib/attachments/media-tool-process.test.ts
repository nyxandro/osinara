/**
 * Tests of the bounded process that runs a media tool on an untrusted file.
 *
 * Constructs covered:
 * - `runMediaTool`: the tool's output, with `PATH` alone and, under root, as `nobody`; its input
 *   file as a descriptor the tool could not open itself.
 * - Refusals for a tool that runs too long, writes too much, fails, cannot start or is not installed.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
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
        args: ["-c", `cat <&${MEDIA_TOOL_INPUT_FD}`],
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
