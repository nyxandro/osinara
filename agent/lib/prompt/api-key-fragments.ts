/**
 * Model instructions for API keys that skills use in sandboxes.
 *
 * Export:
 * - `SANDBOX_API_KEY_USAGE`: how a sandbox command calls a service with a granted key, the same in
 *   every trust zone; who may store or grant a key is said by each zone's own credentials rules.
 */
export const SANDBOX_API_KEY_USAGE =
  "A key granted to this chat reaches Bash as `<NAME>_API_KEY`, a placeholder useless outside this server, and `<NAME>_BASE_URL`, a gateway to call instead of the service's own base URL; the server puts the real key into the request on its way to that service only. Call `$<NAME>_BASE_URL/<path>` with the placeholder where the service expects its key, read both variables in skills and scripts instead of writing an address or a key, and see what this chat has with `env | grep -E '_(API_KEY|BASE_URL)='`.";
