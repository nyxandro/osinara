/**
 * Sandbox egress proxy transport regression tests.
 *
 * Constructs covered:
 * - CONNECT client sockets may close with `EPIPE` without terminating the proxy process.
 */
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxEgressProxy } from "./server.js";

describe("sandbox egress proxy server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles an EPIPE from a disconnected CONNECT client", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createSandboxEgressProxy();
    const clientSocket = new PassThrough() as unknown as Socket;
    const error = Object.assign(new Error("client disconnected"), { code: "EPIPE" });

    server.emit("connect", { url: "invalid-target" }, clientSocket, Buffer.alloc(0));

    expect(() => clientSocket.emit("error", error)).not.toThrow();
    server.removeAllListeners();
  });
});
