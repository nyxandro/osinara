/**
 * Optional HTTP proxy for the main model's calls.
 *
 * Exports:
 * - `parseModelProxyUrl`: validates the optional `MODEL_PROXY_URL` host binding.
 * - `createModelProxyFetch`: fetch that sends every model request through that proxy.
 *
 * Key constructs:
 * - Only model calls take the proxy. A server that cannot reach its provider directly (#485: TCP
 *   from the Netherlands host to the Russian hub stopped opening) names one; Telegram, Google and
 *   the tools keep their own routes.
 * - Every request is tunnelled with CONNECT, so the proxy learns the destination host and never
 *   sees the request, its key or the answer.
 * - Undici's own fetch is paired with its own `ProxyAgent`: Node's bundled fetch is a different
 *   undici build and does not reliably accept a dispatcher from the npm package.
 * - HTTP/1.1 only, like the direct route: the npm undici offers HTTP/2 by default, and then every
 *   concurrent model call of every chat would share one tunnel and fail together when it drops.
 */
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from "undici";

import { AppError } from "./app-error.js";

const PROXY_PROTOCOLS = new Set(["http:", "https:"]);

function invalidProxyUrl(): AppError {
  // Neither the value nor the URL parser's error (it keeps the raw input) is attached: a mistyped
  // binding may carry credentials, and this error is printed at startup.
  return new AppError(
    "AGENT_MODEL_PROXY_URL_INVALID",
    "MODEL_PROXY_URL должен быть адресом HTTP-прокси вида http://хост:порт без пути и учётных данных",
  );
}

/** Returns the proxy origin, or `undefined` when the binding is absent or empty. */
export function parseModelProxyUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!URL.canParse(value)) throw invalidProxyUrl();
  const url = new URL(value);
  if (
    !PROXY_PROTOCOLS.has(url.protocol)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw invalidProxyUrl();
  }
  return url.origin;
}

export function createModelProxyFetch(proxyUrl: string): FetchFunction {
  const dispatcher = new ProxyAgent({ allowH2: false, proxyTunnel: true, uri: proxyUrl });
  return async (input, init) => {
    // AI SDK providers pass the endpoint as a URL string; a Request object would lose its own
    // method and headers when handed to a different fetch implementation.
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new AppError(
        "AGENT_MODEL_PROXY_REQUEST_UNSUPPORTED",
        "Запрос к модели нельзя отправить через прокси",
      );
    }
    const response = await undiciFetch(input, { ...init, dispatcher } as UndiciRequestInit);
    return response as unknown as Response;
  };
}
