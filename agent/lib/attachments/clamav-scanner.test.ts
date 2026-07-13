/**
 * ClamAV streaming scanner tests.
 *
 * Constructs covered:
 * - `createClamAvScanner`: INSTREAM framing and clean result handling.
 * - Malware and unavailable scanner failures are fail-closed.
 */
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createClamAvScanner } from "./clamav-scanner.js";

const servers: Server[] = [];

async function scannerServer(response: string) {
  let received = Buffer.alloc(0);
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.subarray(-4).equals(Buffer.alloc(4))) socket.end(`${response}\0`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test scanner did not bind TCP");
  return { port: address.port, received: () => received };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
});

describe("createClamAvScanner", () => {
  it("streams bytes with the ClamAV INSTREAM protocol", async () => {
    const fixture = await scannerServer("stream: OK");
    const scan = createClamAvScanner({ host: "127.0.0.1", port: fixture.port, timeoutMs: 1_000 });

    await expect(scan(Buffer.from("clean-content"))).resolves.toBeUndefined();
    expect(fixture.received().subarray(0, 10).toString()).toBe("zINSTREAM\0");
    expect(fixture.received().includes(Buffer.from("clean-content"))).toBe(true);
  });

  it("rejects a detected signature", async () => {
    const fixture = await scannerServer("stream: Eicar-Signature FOUND");
    const scan = createClamAvScanner({ host: "127.0.0.1", port: fixture.port, timeoutMs: 1_000 });

    await expect(scan(Buffer.from("infected-content")))
      .rejects.toThrowError(/AGENT_ATTACHMENT_MALWARE_DETECTED/);
  });
});
