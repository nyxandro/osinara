/**
 * Local TEI embedding client tests.
 *
 * Constructs covered:
 * - E5 query and passage requests use distinct required prefixes and pinned model identity.
 * - Missing configuration, provider failures, malformed output, and wrong dimensions fail explicitly.
 * - Network and JSON decoding failures use a safe structured provider contract.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
} from "./memory-config.js";
import {
  embedMemoryPassages,
  embedMemoryQuery,
} from "./memory-embedding-client.js";

const originalBaseUrl = process.env.MEMORY_EMBEDDING_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBaseUrl === undefined) delete process.env.MEMORY_EMBEDDING_BASE_URL;
  else process.env.MEMORY_EMBEDDING_BASE_URL = originalBaseUrl;
});

describe("memory embedding client", () => {
  it("returns ordered passage vectors with the E5 passage prefix", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    const vectors = [
      Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.1),
      Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.2),
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: vectors[1], index: 1, object: "embedding" },
            { embedding: vectors[0], index: 0, object: "embedding" },
          ],
          model: MEMORY_EMBEDDING_MODEL,
          object: "list",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );

    await expect(embedMemoryPassages(["один", "два"], fetchMock)).resolves.toEqual(vectors);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://embedding-worker/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({
      encoding_format: "float",
      input: ["passage: один", "passage: два"],
      model: MEMORY_EMBEDDING_MODEL,
    });
  });

  it("embeds one query with the E5 query prefix", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.5);
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ embedding: vector, index: 0, object: "embedding" }],
        model: MEMORY_EMBEDDING_MODEL,
      }),
    );

    await expect(embedMemoryQuery("где лежат документы", fetchMock)).resolves.toEqual(vector);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.input).toEqual(["query: где лежат документы"]);
  });

  it("embeds every part of a long query without provider truncation", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    const vector = [1, ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 1 }, () => 0)];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { input: string[] };
      return Response.json({
        data: request.input.map((_, index) => ({ embedding: vector, index })),
        model: MEMORY_EMBEDDING_MODEL,
      });
    });
    // Long enough to outgrow the chunk limit several times over, whatever that limit is set to.
    const wordsPerChunk = Math.ceil(MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS / 14);
    const query = Array.from({ length: wordsPerChunk * 3 }, (_, index) => `подробность-${index}`)
      .join(" ");

    await expect(embedMemoryQuery(query, fetchMock)).resolves.toEqual(vector);
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { input: string[] });
    const inputs = requests.flatMap((request) => request.input);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((input) =>
      input.startsWith("query: ") &&
      input.length <= MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS + "query: ".length,
    )).toBe(true);
  });

  it("fails fast when the environment-specific worker URL is absent", async () => {
    delete process.env.MEMORY_EMBEDDING_BASE_URL;

    await expect(embedMemoryPassages(["текст"])).rejects.toThrowError(
      /AGENT_MEMORY_EMBEDDING_CONFIG_MISSING/,
    );
  });

  it("rejects provider errors and vectors with the wrong dimensions", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    // A busy service and a rejected text are told apart by status: only the first is worth
    // another attempt later, and the job queue decides that from this code alone.
    await expect(
      embedMemoryPassages(
        ["текст"],
        vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_PROVIDER_BUSY/);
    await expect(
      embedMemoryPassages(
        ["текст"],
        vi.fn().mockResolvedValue(new Response("too many requests", { status: 429 })),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_PROVIDER_BUSY/);
    await expect(
      embedMemoryPassages(
        ["текст"],
        vi.fn().mockResolvedValue(new Response("payload too large", { status: 413 })),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_PROVIDER_FAILED/);
    await expect(
      embedMemoryPassages(
        ["текст"],
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }], model: MEMORY_EMBEDDING_MODEL }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID/);
  });

  it("rejects a provider serving another model in the same dimensions", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    await expect(
      embedMemoryPassages(
        ["текст"],
        vi.fn().mockResolvedValue(Response.json({
          data: [{
            embedding: Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0),
            index: 0,
          }],
          model: "other/model",
        })),
      ),
    ).rejects.toThrowError(/AGENT_MEMORY_EMBEDDING_MODEL_MISMATCH/);
  });

  it("says which request of a long query went unanswered and how long it waited", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.1);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
        return Response.json({
          data: input.map((_text, index) => ({ embedding: vector, index })),
          model: MEMORY_EMBEDDING_MODEL,
        });
      })
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    const query = Array.from({ length: 11 }, (_unused, index) =>
      `Тема номер ${index}. ${"слово ".repeat(MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS / 6)}`).join("\n\n");

    await expect(embedMemoryQuery(query, fetchMock)).rejects.toThrowError(
      /AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE/,
    );

    // 08.10 the morning query of eleven pieces lost its semantic branch, and the line said only
    // "aborted due to timeout": which of the two requests stalled had to be read off timestamps.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stalled = (JSON.parse(String(fetchMock.mock.calls[1]![1].body)) as { input: string[] }).input;
    const line = JSON.parse(String(errors.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      code: "AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE",
      elapsedMs: expect.any(Number),
      endpoint: "/v1/embeddings",
      texts: stalled.length,
    });
  });

  it.each([
    ["network", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5"))],
    ["json", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 }))],
  ])("normalizes a %s boundary failure without leaking transport details", async (_case, fetchMock) => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding-worker:80";

    await expect(embedMemoryPassages(["текст"], fetchMock)).rejects.toMatchObject({
      contract: {
        category: "dependency",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
    await expect(embedMemoryPassages(["текст"], fetchMock)).rejects.not.toThrow(/10\.0\.0\.5/u);
  });
});
