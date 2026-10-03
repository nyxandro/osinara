/**
 * Production operational boundary tests.
 *
 * Constructs covered:
 * - `assertOperationalHost`: root/Linux fail-fast contract.
 * - `requireExactHealthyResponse`: redirect rejection and exact final URL validation.
 */
import { describe, expect, it, vi } from "vitest";

import {
  assertOperationalHost,
  requireExactHealthyResponse,
} from "./production-operational-commands.js";

const HEALTH_URL = "https://bot.example.com/v1/health";

describe("production operational boundary", () => {
  it.each([
    { gid: 0, platform: "linux", uid: 1000 },
    { gid: 1000, platform: "linux", uid: 0 },
    { gid: 0, platform: "darwin", uid: 0 },
  ])("rejects a non-root or non-Linux host before work: %#", (identity) => {
    expect(() => assertOperationalHost(identity)).toThrowError(expect.objectContaining({
      code: "OSINARA_OPERATION_HOST_UNSUPPORTED",
    }));
  });

  it("requires redirect:error and the exact requested health URL", async () => {
    const response = new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(response, "url", { value: HEALTH_URL });
    const fetch = vi.fn().mockResolvedValue(response);

    await requireExactHealthyResponse(HEALTH_URL, fetch);

    expect(fetch).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ redirect: "error" }));
  });

  it("rejects a successful response whose final URL is not exact", async () => {
    const response = new Response("ok", { status: 200 });
    Object.defineProperty(response, "url", { value: `${HEALTH_URL}/` });
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(requireExactHealthyResponse(HEALTH_URL, fetch)).rejects.toMatchObject({
      code: "OSINARA_OPERATION_HEALTH_FAILED",
    });
  });
});
