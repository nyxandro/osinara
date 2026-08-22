/**
 * Subscription-backed image generation client tests.
 *
 * Constructs covered:
 * - Exact CLIProxyAPI GPT-Image-2 request and bounded WebP response decoding.
 * - Missing credentials and malformed responses fail before an image reaches a workspace.
 * - Provider and transport failures are never retried and retain definitive/ambiguous semantics.
 */
import { describe, expect, it, vi } from "vitest";

import { createImageGenerationClient } from "./image-generation-client.js";

const VP8_FRAME = Buffer.from("0000009d012a01000100", "hex");
const WEBP_BYTES = Buffer.alloc(12 + 8 + VP8_FRAME.byteLength);
WEBP_BYTES.write("RIFF", 0, "ascii");
WEBP_BYTES.writeUInt32LE(WEBP_BYTES.byteLength - 8, 4);
WEBP_BYTES.write("WEBP", 8, "ascii");
WEBP_BYTES.write("VP8 ", 12, "ascii");
WEBP_BYTES.writeUInt32LE(VP8_FRAME.byteLength, 16);
VP8_FRAME.copy(WEBP_BYTES, 20);

function client(fetch: typeof globalThis.fetch, apiKey = "internal-bearer") {
  return createImageGenerationClient({
    apiKey,
    baseUrl: "http://cli-proxy-api:8317/v1",
    fetch,
  });
}

describe("image generation client", () => {
  it("calls the exact subscription image endpoint once and decodes one WebP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        b64_json: WEBP_BYTES.toString("base64"),
        revised_prompt: "A restrained editorial illustration",
      }],
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));

    await expect(client(fetch).generate({
      background: "opaque",
      prompt: "Editorial illustration of a family calendar",
      quality: "high",
      size: "1536x1024",
    })).resolves.toEqual({
      bytes: WEBP_BYTES,
      mediaType: "image/webp",
      model: "gpt-image-2",
      revisedPrompt: "A restrained editorial illustration",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://cli-proxy-api:8317/v1/images/generations");
    expect(init?.headers).toEqual(expect.objectContaining({
      authorization: "Bearer internal-bearer",
      "content-type": "application/json",
    }));
    expect(JSON.parse(String(init?.body))).toEqual({
      background: "opaque",
      model: "gpt-image-2",
      moderation: "auto",
      n: 1,
      output_compression: 90,
      output_format: "webp",
      prompt: "Editorial illustration of a family calendar",
      quality: "high",
      response_format: "b64_json",
      size: "1536x1024",
      stream: false,
    });
  });

  it("fails before network access when the internal bearer is absent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(client(fetch, "").generate({
      background: "auto",
      prompt: "A quiet forest",
      quality: "auto",
      size: "auto",
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_CONFIG_INVALID/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks a rejected prompt as definitive without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "content policy rejection", type: "invalid_request_error" },
    }), {
      headers: { "content-type": "application/json" },
      status: 400,
    }));

    await expect(client(fetch).generate({
      background: "auto",
      prompt: "Rejected prompt",
      quality: "auto",
      size: "auto",
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_REJECTED/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["transport", vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("socket reset"))],
    ["provider", vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("upstream failed", { status: 503 }))],
  ])("marks a %s failure as ambiguous without retrying", async (_case, fetch) => {
    await expect(client(fetch).generate({
      background: "auto",
      prompt: "A city skyline",
      quality: "auto",
      size: "auto",
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful response that is not a WebP image", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("not-an-image").toString("base64") }],
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));

    await expect(client(fetch).generate({
      background: "auto",
      prompt: "A city skyline",
      quality: "auto",
      size: "auto",
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_RESPONSE_INVALID/u);
  });

  it("rejects a header-only WebP container without image data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("524946460400000057454250", "hex").toString("base64") }],
    }), { status: 200 }));

    await expect(client(fetch).generate({
      background: "auto",
      prompt: "A city skyline",
      quality: "auto",
      size: "auto",
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_RESPONSE_INVALID/u);
  });
});
