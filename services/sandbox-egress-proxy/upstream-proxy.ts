/**
 * The sandbox egress proxy's optional upstream route (#489).
 *
 * Exports:
 * - `UpstreamProxy`: a plain HTTP proxy the egress proxy forwards some destinations through.
 * - `parseUpstreamProxyUrl`: validates the optional `SANDBOX_EGRESS_UPSTREAM_PROXY_URL` binding.
 * - `UPSTREAM_DOMAIN_ZONES`, `routedThroughUpstream`: which host names take the upstream route.
 * - `openUpstreamTunnel`: a CONNECT tunnel through the upstream proxy to a checked address.
 * - `watchTunnelAnswer`: tells a destination the upstream could not reach from an ordinary end.
 *
 * Key constructs:
 * - From this server, connections to many Russian sites stopped opening on 14.11.2026, while the
 *   same sites answered through the host's Xray every time (#489). Only names in the Russian zones
 *   take that route; everything else, and every owner-granted address, stays direct.
 * - The egress proxy resolves and checks the destination itself and asks the upstream proxy for the
 *   checked address, never the name: a name the upstream proxy resolved could point anywhere, and the
 *   guarantee that a host name reaches only public addresses must not depend on it.
 * - The host Xray answers a tunnel with 200 before it dials the destination, so a destination its node
 *   cannot reach shows only after the client spoke: the tunnel ends, or stays silent, before a byte
 *   came back.
 */
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";

export interface UpstreamProxy {
  readonly host: string;
  readonly port: number;
}

/** `.ru` and `.рф` (its ASCII form): the sites the direct route of this server cannot open. */
export const UPSTREAM_DOMAIN_ZONES = ["ru", "xn--p1ai"] as const;

const INVALID_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_URL_INVALID";
const NO_ANSWER_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_NO_ANSWER";
// The URL parser drops a port equal to the scheme's default, so a written-out `:80` is read here.
const EXPLICIT_DEFAULT_PORT = /:80\/?$/u;

function invalid(): Error {
  // The value itself is not repeated: a mistyped binding may carry credentials, and this error is
  // printed at startup.
  return new Error(`${INVALID_CODE}: SANDBOX_EGRESS_UPSTREAM_PROXY_URL must be http://host:port without credentials or path`);
}

/** The upstream proxy, or null when the binding is absent or empty: then every destination is direct. */
export function parseUpstreamProxyUrl(value: string | undefined): UpstreamProxy | null {
  if (value === undefined || value === "") return null;
  if (!URL.canParse(value)) throw invalid();
  const url = new URL(value);
  const port = url.port !== "" ? Number(url.port) : EXPLICIT_DEFAULT_PORT.test(value) ? 80 : null;
  if (
    url.protocol !== "http:" || url.username !== "" || url.password !== "" || port === null || port === 0
    || url.pathname !== "/" || url.search !== "" || url.hash !== ""
  ) {
    throw invalid();
  }
  // An IPv6 address comes with the brackets of its URL form, which a connection does not take.
  return { host: url.hostname.replace(/^\[(.*)\]$/u, "$1"), port };
}

export function routedThroughUpstream(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, "");
  return UPSTREAM_DOMAIN_ZONES.some((zone) => name === zone || name.endsWith(`.${zone}`));
}

/**
 * A socket that carries bytes to `address:port` through the upstream proxy, or an error when the
 * proxy cannot be reached, refuses the tunnel, does not open it before the deadline, or the client it
 * serves has left (`clientGone`). The socket has no idle limit of its own: the caller sets one.
 */
export async function openUpstreamTunnel(
  proxy: UpstreamProxy,
  address: string,
  port: number,
  timeoutMilliseconds: number,
  clientGone: AbortSignal,
): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const target = `${address}:${port}`;
    const connectRequest = httpRequest({
      // Node's shared agent would give the tunnel its own 5 s idle limit, which would then cut a
      // slow site's plain HTTP answer long before the 15 s of the direct route.
      agent: false,
      headers: { host: target },
      host: proxy.host,
      method: "CONNECT",
      path: target,
      port: proxy.port,
    });
    const abandon = () => connectRequest.destroy(
      new Error("AGENT_SANDBOX_EGRESS_CLIENT_GONE: The client left before the upstream proxy opened the tunnel"),
    );
    const deadline = setTimeout(() => connectRequest.destroy(
      new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: The upstream proxy did not open the tunnel in time"),
    ), timeoutMilliseconds);
    deadline.unref();
    const settle = () => {
      clearTimeout(deadline);
      clientGone.removeEventListener("abort", abandon);
    };
    if (clientGone.aborted) abandon();
    else clientGone.addEventListener("abort", abandon, { once: true });
    connectRequest.once("connect", (response, socket, head) => {
      settle();
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`AGENT_SANDBOX_EGRESS_UPSTREAM_REFUSED: The upstream proxy answered ${response.statusCode ?? "nothing"}`));
        return;
      }
      // Bytes the destination already sent after the proxy's answer belong to the tunnel.
      if (head.byteLength > 0) socket.unshift(head);
      resolve(socket);
    });
    connectRequest.once("error", (error) => {
      settle();
      reject(error);
    });
    connectRequest.end();
  });
}

export interface TunnelAnswerWatch {
  readonly answerTimeoutMilliseconds: number;
  /** The client sent bytes together with its tunnel request: it has already asked. */
  readonly asked: boolean;
  readonly client: Socket;
  /** Called at most once, when the destination's first byte comes back: the site opened (#499). */
  readonly onAnswer: () => void;
  /** Called at most once, when the destination did not answer what the client asked. */
  readonly onNoAnswer: (errorCode: string | null, errorMessage: string) => void;
  /** A tunnel failure that is ordinary traffic: after the destination answered, or before any question. */
  readonly onTunnelError: (error: NodeJS.ErrnoException) => void;
  readonly tunnel: Socket;
}

/**
 * Watches an open upstream tunnel for the destination's first byte. Once the client has asked, a
 * tunnel that ends or stays silent past the deadline without a byte back is a destination the
 * upstream could not reach, and a silent one is closed. For TLS the destination answers the client's
 * first message at once, and a plain HTTP site gets as long as on the direct route.
 */
export function watchTunnelAnswer(watch: TunnelAnswerWatch): void {
  const { client, tunnel } = watch;
  let asked = false;
  let answered = false;
  let settled = false;
  let deadline: NodeJS.Timeout | undefined;
  const noAnswer = (errorCode: string | null, reason: string) => {
    settled = true;
    watch.onNoAnswer(errorCode, `${NO_ANSWER_CODE}: ${reason}`);
  };
  const awaitAnswer = () => {
    // A destination that spoke first has answered already: there is nothing left to wait for.
    if (answered) return;
    asked = true;
    deadline = setTimeout(() => {
      noAnswer(null, `The destination sent nothing within ${watch.answerTimeoutMilliseconds} ms`);
      tunnel.destroy();
    }, watch.answerTimeoutMilliseconds);
    deadline.unref();
  };
  if (watch.asked) awaitAnswer();
  else client.once("data", awaitAnswer);
  tunnel.once("data", () => {
    answered = true;
    clearTimeout(deadline);
    watch.onAnswer();
  });
  tunnel.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(deadline);
    if (settled) return;
    if (asked && !answered && !client.destroyed) {
      noAnswer(error.code ?? null, "The tunnel failed before the destination sent anything");
      return;
    }
    settled = true;
    watch.onTunnelError(error);
  });
  tunnel.once("close", () => {
    clearTimeout(deadline);
    client.off("data", awaitAnswer);
    if (settled || !asked || answered || client.destroyed) return;
    noAnswer(null, "The tunnel closed before the destination sent anything");
  });
}
