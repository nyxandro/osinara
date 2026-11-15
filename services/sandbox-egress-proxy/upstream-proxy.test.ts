/**
 * Which destinations the sandbox egress proxy sends through its upstream proxy (#489).
 *
 * Constructs covered:
 * - The optional `SANDBOX_EGRESS_UPSTREAM_PROXY_URL` binding names a plain HTTP proxy by host and
 *   port; an absent or empty binding means every destination stays direct, and anything else stops
 *   the proxy at startup instead of failing every request later.
 * - Only host names in the Russian zones `.ru` and `.рф` take the upstream route, whatever their
 *   letter case or trailing dot; a name that merely contains those letters stays direct.
 * - A tunnel request to the upstream proxy gives up at its deadline, and at once when the sandbox
 *   client it serves has left.
 * - Xray answers 200 before it dials, so an unreachable destination is a tunnel that ends, or stays
 *   silent past the deadline, after the client asked and before a byte came back: reported once as
 *   no answer. A tunnel that ends after the answer, before any question, or after its client left is
 *   ordinary traffic.
 */
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openUpstreamTunnel,
  parseUpstreamProxyUrl,
  routedThroughUpstream,
  watchTunnelAnswer,
} from "./upstream-proxy.js";

describe("sandbox egress upstream proxy binding", () => {
  it.each([undefined, ""])("keeps every destination direct without a binding (%j)", (value) => {
    expect(parseUpstreamProxyUrl(value)).toBeNull();
  });

  it.each([
    ["http://172.17.0.1:10811", { host: "172.17.0.1", port: 10811 }],
    // The URL parser drops a port equal to the scheme's default; written out, it is still explicit.
    ["http://172.17.0.1:80", { host: "172.17.0.1", port: 80 }],
    ["http://[fd00::1]:10811/", { host: "fd00::1", port: 10811 }],
  ])("takes the host and port of the plain HTTP proxy %s", (value, proxy) => {
    expect(parseUpstreamProxyUrl(value)).toEqual(proxy);
  });

  it.each([
    ["an HTTPS proxy", "https://172.17.0.1:10811"],
    ["credentials", "http://user:secret@172.17.0.1:10811"],
    ["a path", "http://172.17.0.1:10811/proxy"],
    ["a query", "http://172.17.0.1:10811/?x=1"],
    ["no port", "http://172.17.0.1"],
    ["port zero", "http://172.17.0.1:0"],
    ["something else", "not a url"],
  ])("refuses %s at startup without echoing the value", (_case, value) => {
    expect(() => parseUpstreamProxyUrl(value)).toThrowError(/^AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_URL_INVALID: /u);
    try {
      parseUpstreamProxyUrl(value);
    } catch (error) {
      // A mistyped binding may carry credentials, and this error is printed at startup.
      expect((error as Error).message).not.toContain("secret");
    }
  });
});

describe("destinations of the upstream route", () => {
  it.each(["fivepost.ru", "www.ozon.ru", "API-OMNI.X5.RU", "x5.ru.", "ru", "xn--80aswg.xn--p1ai"])(
    "sends %s through the upstream proxy",
    (hostname) => {
      expect(routedThroughUpstream(hostname)).toBe(true);
    },
  );

  it.each(["example.com", "ru.example.com", "shop-ru.com", "notru", "xn--p1ai.example.com", "193.232.108.16"])(
    "keeps %s direct",
    (hostname) => {
      expect(routedThroughUpstream(hostname)).toBe(false);
    },
  );
});

const servers: Server[] = [];

/** An upstream proxy that accepts the connection and never answers the tunnel request. */
async function silentUpstream(): Promise<{ port: number; asked: Promise<Socket> }> {
  let accepted: (socket: Socket) => void = () => undefined;
  const asked = new Promise<Socket>((resolve) => { accepted = resolve; });
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    accepted(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { asked, port: (server.address() as AddressInfo).port };
}

describe("tunnel through the upstream proxy", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("gives up when the upstream proxy does not open the tunnel before the deadline", async () => {
    const upstream = await silentUpstream();

    await expect(openUpstreamTunnel(
      { host: "127.0.0.1", port: upstream.port },
      "93.184.215.14",
      443,
      100,
      new AbortController().signal,
    )).rejects.toThrowError(/^AGENT_SANDBOX_EGRESS_TIMEOUT: /u);
    (await upstream.asked).destroy();
  });

  it("lets go of the upstream proxy at once when the client it serves has left", async () => {
    const upstream = await silentUpstream();
    const clientLeft = new AbortController();

    const opening = openUpstreamTunnel({ host: "127.0.0.1", port: upstream.port }, "93.184.215.14", 443, 60_000, clientLeft.signal);
    const asked = await upstream.asked;
    const releasedSocket = new Promise<void>((resolve) => asked.once("close", () => resolve()));
    clientLeft.abort();

    await expect(opening).rejects.toThrowError(/^AGENT_SANDBOX_EGRESS_CLIENT_GONE: /u);
    await releasedSocket;
  });
});

/** A socket stand-in: bytes pushed into it arrive as `data`, and it closes like a socket. */
function fakeSocket(): Socket {
  return new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }) as unknown as Socket;
}

function resetError(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

async function tick(milliseconds = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("answer of the destination through an upstream tunnel", () => {
  const ANSWER_TIMEOUT_MILLISECONDS = 40;

  function watched(asked = false) {
    const client = fakeSocket();
    const tunnel = fakeSocket();
    const onAnswer = vi.fn();
    const onNoAnswer = vi.fn();
    const onTunnelError = vi.fn();
    watchTunnelAnswer({ answerTimeoutMilliseconds: ANSWER_TIMEOUT_MILLISECONDS, asked, client, onAnswer, onNoAnswer, onTunnelError, tunnel });
    return { client, onAnswer, onNoAnswer, onTunnelError, tunnel };
  }

  it("reports a destination that stays silent after the client asked, and closes the tunnel", async () => {
    const { client, onAnswer, onNoAnswer, tunnel } = watched();

    client.push("client hello");
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    expect(onAnswer).not.toHaveBeenCalled();
    expect(onNoAnswer).toHaveBeenCalledExactlyOnceWith(null, expect.stringMatching(/^AGENT_SANDBOX_EGRESS_UPSTREAM_NO_ANSWER: /u));
    expect(tunnel.destroyed).toBe(true);
  });

  it("counts bytes sent together with the tunnel request as the client's question", async () => {
    const { onNoAnswer } = watched(true);

    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    expect(onNoAnswer).toHaveBeenCalledOnce();
  });

  it.each([
    ["closes", null],
    ["resets", "ECONNRESET"],
  ] as const)("reports once a tunnel that %s before the destination answered", async (_case, errorCode) => {
    const { client, onNoAnswer, onTunnelError, tunnel } = watched();

    client.push("client hello");
    await tick();
    tunnel.destroy(errorCode === null ? undefined : resetError());
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    expect(onNoAnswer).toHaveBeenCalledExactlyOnceWith(errorCode, expect.stringMatching(/^AGENT_SANDBOX_EGRESS_UPSTREAM_NO_ANSWER: /u));
    expect(onTunnelError).not.toHaveBeenCalled();
  });

  it("treats a tunnel that ends after the destination answered as ordinary traffic", async () => {
    const { client, onAnswer, onNoAnswer, onTunnelError, tunnel } = watched();

    client.push("client hello");
    await tick();
    tunnel.push("server hello");
    await tick();
    tunnel.push("more of the page");
    await tick();
    tunnel.destroy(resetError());
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    // The site opened once, however much it sent (#499).
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onNoAnswer).not.toHaveBeenCalled();
    expect(onTunnelError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ECONNRESET" }));
  });

  it("keeps a tunnel whose destination spoke first, and reports its answer once", async () => {
    const { client, onAnswer, onNoAnswer, tunnel } = watched();

    tunnel.push("server greeting");
    await tick();
    client.push("client request");
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    // The answer came before the question: waiting for one would cut a working tunnel (#499).
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onNoAnswer).not.toHaveBeenCalled();
    expect(tunnel.destroyed).toBe(false);
  });

  it("ignores a tunnel that ends before the client asked anything", async () => {
    const { onNoAnswer, onTunnelError, tunnel } = watched();

    tunnel.destroy();
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    expect(onNoAnswer).not.toHaveBeenCalled();
    expect(onTunnelError).not.toHaveBeenCalled();
  });

  it("ignores the end of a tunnel whose client left first", async () => {
    const { client, onNoAnswer, tunnel } = watched();

    client.push("client hello");
    await tick();
    client.destroy();
    tunnel.destroy();
    await tick(ANSWER_TIMEOUT_MILLISECONDS * 3);

    expect(onNoAnswer).not.toHaveBeenCalled();
  });
});
