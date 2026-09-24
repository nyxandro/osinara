/**
 * Sandbox egress proxy transport regression tests.
 *
 * Constructs covered:
 * - CONNECT client sockets may close with `EPIPE` without terminating the proxy process.
 * - TCP establishment has a bounded deadline that is removed from an established idle tunnel.
 */
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindTunnelLifecycle,
  connectWithDeadline,
  createSandboxEgressProxy,
} from "./server.js";

function upstreamSocket(): Socket {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    destroyed: false,
    end: vi.fn(),
    writableEnded: false,
  }) as unknown as Socket;
}

describe("sandbox egress proxy server", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("handles an EPIPE from a disconnected CONNECT client", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const server = createSandboxEgressProxy();
    const clientSocket = new PassThrough() as unknown as Socket;
    const error = Object.assign(new Error("client disconnected"), { code: "EPIPE" });

    server.emit("connect", { url: "invalid-target" }, clientSocket, Buffer.alloc(0));

    expect(() => clientSocket.emit("error", error)).not.toThrow();
    server.removeAllListeners();
  });

  it("destroys an upstream socket that does not connect before the deadline", async () => {
    vi.useFakeTimers();
    const socket = upstreamSocket();

    connectWithDeadline(() => socket, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(socket.destroy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("AGENT_SANDBOX_EGRESS_TIMEOUT"),
    }));
  });

  it("does not treat an established idle tunnel as a connection timeout", async () => {
    vi.useFakeTimers();
    const socket = upstreamSocket();

    connectWithDeadline(() => socket, 15_000);
    socket.emit("connect");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it.each(["connecting", "tunnel"] as const)(
    "destroys an upstream %s socket when its client fails",
    (phase) => {
      const client = upstreamSocket();
      const upstream = upstreamSocket();
      bindTunnelLifecycle(client, upstream);
      if (phase === "tunnel") upstream.emit("connect");

      client.emit("error", new Error("client reset"));

      expect(upstream.destroy).toHaveBeenCalledOnce();
    },
  );

  it("ends the client socket without discarding buffered data when its upstream closes", () => {
    const client = upstreamSocket();
    const upstream = upstreamSocket();
    bindTunnelLifecycle(client, upstream);

    upstream.emit("close");

    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
  });
});
