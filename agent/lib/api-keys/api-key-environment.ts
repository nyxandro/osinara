/**
 * What a sandbox command sees of the API keys granted to its session.
 *
 * Export:
 * - `apiKeySandboxEnvironment`: `<NAME>_API_KEY` (the grant's placeholder) and `<NAME>_BASE_URL`
 *   (the gateway) for every stored key granted to the given workspaces.
 *
 * Names follow common SDK conventions, so an OpenAI-compatible client reads `OPENAI_API_KEY` and
 * `OPENAI_BASE_URL` of a key named `openai` without extra code.
 */
import { apiKeyEnvironmentNames, apiKeyGatewayBaseUrl } from "./api-key-contract.js";
import { apiKeyRepository } from "./api-key-repository.js";

/** Workspaces in priority order: a private chat lists the personal one before the family's. */
export async function apiKeySandboxEnvironment(workspaceIds: readonly string[]): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const { name, placeholder } of await apiKeyRepository.environmentGrants(workspaceIds)) {
    const names = apiKeyEnvironmentNames(name);
    if (Object.hasOwn(environment, names.apiKey)) continue;
    environment[names.apiKey] = placeholder;
    environment[names.baseUrl] = apiKeyGatewayBaseUrl(name);
  }
  return environment;
}
