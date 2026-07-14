/**
 * Checksum-pinned gws installer tests.
 *
 * Constructs covered:
 * - Supported Docker architectures resolve exact official artifacts and SHA-256 digests.
 * - Unsupported platforms fail before any download occurs.
 */
import { describe, expect, it } from "vitest";

import { resolveGoogleWorkspaceCliArtifact } from "./install-google-workspace-cli.js";

describe("Google Workspace CLI installer", () => {
  it("pins the exact x64 and arm64 release artifacts", () => {
    expect(resolveGoogleWorkspaceCliArtifact("linux", "x64")).toEqual({
      archiveName: "google-workspace-cli-x86_64-unknown-linux-musl.tar.gz",
      sha256: "4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920",
    });
    expect(resolveGoogleWorkspaceCliArtifact("linux", "arm64")).toEqual({
      archiveName: "google-workspace-cli-aarch64-unknown-linux-musl.tar.gz",
      sha256: "e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a",
    });
  });

  it("rejects non-Linux and unsupported CPU targets", () => {
    expect(() => resolveGoogleWorkspaceCliArtifact("darwin", "x64")).toThrowError(
      /AGENT_GWS_PLATFORM_UNSUPPORTED/,
    );
    expect(() => resolveGoogleWorkspaceCliArtifact("linux", "riscv64")).toThrowError(
      /AGENT_GWS_PLATFORM_UNSUPPORTED/,
    );
  });
});
