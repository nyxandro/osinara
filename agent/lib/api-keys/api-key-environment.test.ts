/**
 * Sandbox variables of the API keys granted to a session's workspaces.
 *
 * Constructs covered:
 * - Each stored, granted key appears as its placeholder and the gateway address, never its value.
 * - A key granted both personally and to the family appears once, with the first workspace's
 *   placeholder: the personal one in a private chat.
 */
import { describe, expect, it, vi } from "vitest";

const { environmentGrants } = vi.hoisted(() => ({ environmentGrants: vi.fn() }));
vi.mock("./api-key-repository.js", () => ({ apiKeyRepository: { environmentGrants } }));

import { apiKeySandboxEnvironment } from "./api-key-environment.js";

describe("API key sandbox environment", () => {
  it("gives each key once, from the first workspace that has it", async () => {
    environmentGrants.mockResolvedValue([
      { name: "neuraldeep", placeholder: "osk_personal" },
      { name: "openai", placeholder: "osk_openai" },
      { name: "neuraldeep", placeholder: "osk_family" },
    ]);

    const environment = await apiKeySandboxEnvironment(["personal-workspace", "family-workspace"]);

    expect(environmentGrants).toHaveBeenCalledWith(["personal-workspace", "family-workspace"]);
    expect(environment).toEqual({
      NEURALDEEP_API_KEY: "osk_personal",
      NEURALDEEP_BASE_URL: "http://sandbox-egress-proxy:3129/neuraldeep",
      OPENAI_API_KEY: "osk_openai",
      OPENAI_BASE_URL: "http://sandbox-egress-proxy:3129/openai",
    });
  });
});
