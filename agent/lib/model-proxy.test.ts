/**
 * Model proxy tests.
 *
 * Constructs covered:
 * - `parseModelProxyUrl`: the optional `MODEL_PROXY_URL` binding is a bare HTTP(S) proxy origin.
 * - `createConfiguredLanguageModel` with `proxyUrl`: the model call is tunnelled through the proxy,
 *   a model without it goes straight to the provider, an abort stops a proxied call, and a refusing
 *   proxy fails the call.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { isAppError } from "./app-error.js";
import { parseModelProxyUrl } from "./model-proxy.js";
import { createConfiguredLanguageModel } from "./model-transport.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** OpenAI-compatible provider stub that answers one fixed completion and records what reached it. */
async function startProvider(received: { authorization?: string; requests: number }): Promise<number> {
  return await listen(createServer((incoming, response) => {
    received.requests += 1;
    received.authorization = incoming.headers.authorization;
    incoming.resume();
    incoming.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "Париж", role: "assistant" } }],
        created: 1,
        id: "chatcmpl-proxy-test",
        model: "test-model",
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 5, total_tokens: 6 },
      }));
    });
  }));
}

/** CONNECT-only proxy, like the host Xray inbound: it relays bytes and sees only the destination. */
async function startProxy(tunnels: string[], refuse = false): Promise<number> {
  const server = createServer((_incoming, response) => {
    response.writeHead(405);
    response.end();
  });
  server.on("connect", (incoming: IncomingMessage, client: Socket, head: Buffer) => {
    tunnels.push(incoming.url ?? "");
    if (refuse) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [host, port] = (incoming.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return await listen(server);
}

function modelThrough(providerPort: number, proxyUrl?: string) {
  return createConfiguredLanguageModel({
    apiKey: "test-model-key",
    maxOutputTokens: 100,
    modelId: "test-model",
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    transport: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      protocol: "openai-chat-completions",
      providerName: "neuraldeep",
      reasoning: null,
    },
  });
}

describe("parseModelProxyUrl", () => {
  it("treats an absent or empty binding as no proxy", () => {
    expect(parseModelProxyUrl(undefined)).toBeUndefined();
    expect(parseModelProxyUrl("")).toBeUndefined();
  });

  it("accepts an HTTP or HTTPS proxy origin", () => {
    expect(parseModelProxyUrl("http://172.17.0.1:10810")).toBe("http://172.17.0.1:10810");
    expect(parseModelProxyUrl("https://proxy.example:8443/")).toBe("https://proxy.example:8443");
  });

  it.each([
    "172.17.0.1:10810",
    "socks5://172.17.0.1:10808",
    "http://user:secret@172.17.0.1:10810",
    "http://172.17.0.1:10810/models",
    "http://172.17.0.1:10810?route=model",
  ])("rejects %s with a stable code and without echoing the value", (value) => {
    let failure: unknown;
    try {
      parseModelProxyUrl(value);
    } catch (error) {
      failure = error;
    }
    expect(isAppError(failure) && failure.code).toBe("AGENT_MODEL_PROXY_URL_INVALID");
    expect(String((failure as Error).message)).not.toContain("secret");
  });
});

describe("model calls through MODEL_PROXY_URL", () => {
  it("tunnels the model request through the proxy and delivers the answer", async () => {
    const received = { requests: 0 } as { authorization?: string; requests: number };
    const providerPort = await startProvider(received);
    const tunnels: string[] = [];
    const proxyPort = await startProxy(tunnels);

    const result = await generateText({
      model: modelThrough(providerPort, `http://127.0.0.1:${proxyPort}`),
      prompt: "Столица Франции?",
    });

    expect(result.text).toBe("Париж");
    expect(tunnels).toEqual([`127.0.0.1:${providerPort}`]);
    expect(received).toEqual({ authorization: "Bearer test-model-key", requests: 1 });
  });

  it("goes straight to the provider when no proxy is configured", async () => {
    const received = { requests: 0 } as { authorization?: string; requests: number };
    const providerPort = await startProvider(received);
    const tunnels: string[] = [];
    await startProxy(tunnels);

    const result = await generateText({ model: modelThrough(providerPort), prompt: "Столица Франции?" });

    expect(result.text).toBe("Париж");
    expect(tunnels).toEqual([]);
    expect(received.requests).toBe(1);
  });

  it("stops a proxied call when the turn aborts it, without waiting for a silent provider", async () => {
    // The turn's per-attempt watchdog relies on abort; a hung tunnel must not outlive it.
    const silentProviderPort = await listen(createServer((incoming) => incoming.resume()));
    const tunnels: string[] = [];
    const proxyPort = await startProxy(tunnels);
    const startedAt = Date.now();

    await expect(generateText({
      abortSignal: AbortSignal.timeout(300),
      maxRetries: 0,
      model: modelThrough(silentProviderPort, `http://127.0.0.1:${proxyPort}`),
      prompt: "Столица Франции?",
    })).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(tunnels).toEqual([`127.0.0.1:${silentProviderPort}`]);
  });

  it("fails the call when the proxy refuses the tunnel instead of going around it", async () => {
    const received = { requests: 0 } as { authorization?: string; requests: number };
    const providerPort = await startProvider(received);
    const tunnels: string[] = [];
    const proxyPort = await startProxy(tunnels, true);

    await expect(generateText({
      maxRetries: 0,
      model: modelThrough(providerPort, `http://127.0.0.1:${proxyPort}`),
      prompt: "Столица Франции?",
    })).rejects.toThrow();

    expect(tunnels).toEqual([`127.0.0.1:${providerPort}`]);
    expect(received.requests).toBe(0);
  });
});
