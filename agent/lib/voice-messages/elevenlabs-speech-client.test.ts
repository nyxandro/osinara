/**
 * ElevenLabs text-to-speech transport tests.
 *
 * Constructs covered:
 * - One request carries the pinned voice, model, Ogg Opus output format, and API key header.
 * - A received provider error becomes a stable definitive or ambiguous application code.
 * - A success response is accepted only as bounded Ogg Opus audio.
 * - A missing credential fails before any network request.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ELEVENLABS_TTS_MODEL_ID,
  ELEVENLABS_VOICE_ID,
  createElevenLabsSpeechClient,
} from "./elevenlabs-speech-client.js";

const OGG_OPUS = Buffer.concat([
  Buffer.from("OggS", "ascii"),
  Buffer.alloc(24),
  Buffer.from("OpusHead", "ascii"),
  Buffer.alloc(32),
]);

function audioResponse(bytes: Buffer = OGG_OPUS, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    headers: { "character-cost": "42", "content-type": "audio/opus", ...headers },
    status: 200,
  });
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({
    detail: { code, message: "provider message", request_id: "request-1", type: "error" },
  }), { headers: { "content-type": "application/json" }, status });
}

describe("ElevenLabs speech client", () => {
  it("requests one Ogg Opus synthesis with the pinned voice and model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    const client = createElevenLabsSpeechClient({ apiKey: "sk_test", fetch: fetchMock });

    await expect(client.synthesize("Привет! [laughs] Это голосовое.")).resolves.toEqual({
      bytes: OGG_OPUS,
      characterCost: 42,
      mediaType: "audio/ogg; codecs=opus",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.origin).toBe("https://api.elevenlabs.io");
    expect(parsedUrl.pathname).toBe(`/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`);
    expect(parsedUrl.searchParams.get("output_format")).toBe("opus_48000_64");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ "content-type": "application/json", "xi-api-key": "sk_test" });
    expect(JSON.parse(String(request.body))).toEqual({
      model_id: ELEVENLABS_TTS_MODEL_ID,
      text: "Привет! [laughs] Это голосовое.",
      voice_settings: { stability: 0.5 },
    });
    expect(ELEVENLABS_TTS_MODEL_ID).toBe("eleven_v3");
  });

  it.each([
    ["absent", {}],
    ["empty", { "character-cost": "" }],
    ["not a number", { "character-cost": "n/a" }],
  ])("records an unknown character cost when the header is %s", async (_label, headers) => {
    const response = new Response(new Uint8Array(OGG_OPUS), {
      headers: { "content-type": "audio/opus", ...headers },
      status: 200,
    });
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_test",
      fetch: vi.fn().mockResolvedValue(response),
    });

    await expect(client.synthesize("Текст")).resolves.toMatchObject({ characterCost: null });
  });

  it("fails before the network when the API key is not configured", async () => {
    const fetchMock = vi.fn();

    for (const apiKey of [undefined, "", "sk with space"]) {
      const client = createElevenLabsSpeechClient({ apiKey, fetch: fetchMock });
      expect(() => client.assertConfigured()).toThrowError(/AGENT_VOICE_MESSAGE_CONFIG_MISSING/u);
      await expect(client.synthesize("Текст")).rejects.toThrowError(/AGENT_VOICE_MESSAGE_CONFIG_MISSING/u);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [402, "insufficient_credits", "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED", "definitive"],
    [402, "paid_plan_required", "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED", "definitive"],
    [401, "quota_exceeded", "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED", "definitive"],
    [401, "invalid_api_key", "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED", "definitive"],
    [403, "voice_access_denied", "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED", "definitive"],
    [400, "text_too_long", "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED", "definitive"],
    [404, "voice_not_found", "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED", "definitive"],
    [422, "invalid_parameters", "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED", "definitive"],
    [429, "rate_limit_exceeded", "AGENT_VOICE_MESSAGE_PROVIDER_RATE_LIMITED", "definitive"],
    [500, "internal_error", "AGENT_VOICE_MESSAGE_PROVIDER_UNAVAILABLE", "ambiguous"],
    [503, "service_unavailable", "AGENT_VOICE_MESSAGE_PROVIDER_UNAVAILABLE", "ambiguous"],
  ] as const)("maps HTTP %i %s to %s", async (status, providerCode, code, outcome) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_secret",
      fetch: vi.fn().mockResolvedValue(errorResponse(status, providerCode)),
    });

    const error = await client.synthesize("Текст").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, outcome });
    const logged = consoleError.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain(providerCode);
    expect(logged).not.toContain("sk_secret");
    expect(logged).not.toContain("Текст");
    consoleError.mockRestore();
  });

  it("classifies an exhausted balance reported only in the legacy status field", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_test",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        detail: { message: "quota", status: "quota_exceeded" },
      }), { status: 401 })),
    });

    await expect(client.synthesize("Текст")).rejects.toMatchObject({
      code: "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
      outcome: "definitive",
    });
    consoleError.mockRestore();
  });

  it("treats a connection lost while the audio downloads as an ambiguous outcome", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(OGG_OPUS.subarray(0, 8)));
        controller.error(new TypeError("terminated"));
      },
    });
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_test",
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    });

    await expect(client.synthesize("Текст")).rejects.toMatchObject({
      code: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
      outcome: "ambiguous",
    });
    consoleError.mockRestore();
  });

  it("treats a transport failure or timeout as an ambiguous outcome", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timeout = new DOMException("The operation timed out.", "TimeoutError");

    for (const failure of [new TypeError("fetch failed"), timeout]) {
      const client = createElevenLabsSpeechClient({
        apiKey: "sk_test",
        fetch: vi.fn().mockRejectedValue(failure),
      });
      await expect(client.synthesize("Текст")).rejects.toMatchObject({
        code: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
        outcome: "ambiguous",
      });
    }
    consoleError.mockRestore();
  });

  it.each([
    ["empty body", Buffer.alloc(0)],
    ["MP3 instead of Ogg Opus", Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000audio", "latin1")],
    ["Ogg without an Opus stream", Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(40)])],
    // Delivery sniffs the stored file the same way, so the client must not accept what it rejects.
    ["an Opus header outside the first page position", Buffer.concat([
      Buffer.from("OggS", "ascii"),
      Buffer.alloc(40),
      Buffer.from("OpusHead", "ascii"),
      Buffer.alloc(32),
    ])],
  ])("rejects a success response with %s", async (_label, bytes) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_test",
      fetch: vi.fn().mockResolvedValue(audioResponse(bytes)),
    });

    await expect(client.synthesize("Текст")).rejects.toMatchObject({
      code: "AGENT_VOICE_MESSAGE_PROVIDER_RESPONSE_INVALID",
      outcome: "ambiguous",
    });
    consoleError.mockRestore();
  });

  it("rejects an oversized success response without buffering it whole", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createElevenLabsSpeechClient({
      apiKey: "sk_test",
      fetch: vi.fn().mockResolvedValue(audioResponse(OGG_OPUS, {
        "content-length": String(64 * 1024 * 1024),
      })),
    });

    await expect(client.synthesize("Текст")).rejects.toMatchObject({
      code: "AGENT_VOICE_MESSAGE_PROVIDER_RESPONSE_INVALID",
    });
    consoleError.mockRestore();
  });
});
