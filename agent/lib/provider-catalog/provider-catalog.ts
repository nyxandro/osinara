/**
 * Live provider model catalog boundary.
 *
 * Exports:
 * - `fetchProviderCatalog`: fetches and normalizes one supported provider's `/models` response.
 * - Public provider, protocol, model, reasoning, fetch, and options types.
 *
 * Key constructs:
 * - Provider-specific endpoint/auth contracts with an injected fetch dependency.
 * - One bounded AbortSignal deadline shared by live and models.dev requests.
 * - Fail-fast dispatch to strict live and metadata response parsers.
 */
import { AppError } from "../app-error.js";
import { enrichModelsFromModelsDev } from "./models-dev-parser.js";
import { parseOpenAiModelList } from "./openai-model-list-parser.js";
import { parseOpenRouterModels } from "./openrouter-model-parser.js";
import { getOpenCodeGoProtocol } from "./opencode-go-models.js";
import { selectSupportedNeuralDeepModels } from "./neuraldeep-models.js";
import { providerCatalogError } from "./provider-catalog-errors.js";
import type {
  FetchProviderCatalogOptions,
  ProviderCatalogModel,
  ProviderId,
  ProviderProtocol,
} from "./provider-catalog-types.js";

export type {
  FetchProviderCatalogOptions,
  ProviderCatalogFetch,
  ProviderCatalogModel,
  ProviderId,
  ProviderProtocol,
  ReasoningEffort,
  ReasoningSelection,
} from "./provider-catalog-types.js";

const MAX_TIMEOUT_MS = 30_000;
const MODELS_DEV_URL = "https://models.dev/api.json";

interface ProviderEndpoint {
  authentication: "optional" | "required";
  protocol: ProviderProtocol | null;
  url: string;
}

/** URLs and auth behavior are integration contracts, not environment-specific configuration. */
const PROVIDER_ENDPOINTS = {
  deepseek: {
    authentication: "required",
    protocol: "openai-chat-completions",
    url: "https://api.deepseek.com/models",
  },
  minimax: {
    authentication: "required",
    protocol: "anthropic-messages",
    url: "https://api.minimax.io/v1/models",
  },
  neuraldeep: {
    authentication: "required",
    protocol: "openai-chat-completions",
    url: "https://api.neuraldeep.ru/v1/models",
  },
  "opencode-go": {
    authentication: "optional",
    protocol: null,
    url: "https://opencode.ai/zen/go/v1/models",
  },
  openrouter: {
    authentication: "optional",
    protocol: "openai-chat-completions",
    url: "https://openrouter.ai/api/v1/models",
  },
} as const satisfies Record<ProviderId, ProviderEndpoint>;

interface LiveModelReference {
  id: string;
  protocol: ProviderProtocol;
}

/** Delegates to provider-specific schemas after the transport has established a successful response. */
function parseLiveProviderResponse(
  providerId: Exclude<ProviderId, "openrouter">,
  body: unknown,
): LiveModelReference[] {
  const entries = parseOpenAiModelList(providerId, body);
  if (providerId === "opencode-go") {
    return entries.flatMap(({ id }) => {
      const protocol = getOpenCodeGoProtocol(id);
      return protocol ? [{ id, protocol }] : [];
    });
  }

  const protocol = PROVIDER_ENDPOINTS[providerId].protocol;
  if (!protocol) {
    throw providerCatalogError("response-invalid", providerId);
  }

  return entries.map(({ id }) => ({ id, protocol }));
}

/** Races headers and body consumption against the same absolute catalog deadline. */
async function fetchJsonWithinDeadline(
  fetch: FetchProviderCatalogOptions["fetch"],
  url: string,
  init: RequestInit,
  timeoutPromise: Promise<never>,
  providerId: ProviderId,
  boundary: "live" | "metadata",
): Promise<unknown> {
  let response: Response;
  try {
    response = await Promise.race([fetch(url, init), timeoutPromise]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerCatalogError(
      boundary === "live" ? "request-failed" : "metadata-request-failed",
      providerId,
    );
  }

  if (!response.ok) {
    throw providerCatalogError(
      boundary === "live" ? "http-failed" : "metadata-http-failed",
      providerId,
    );
  }

  try {
    return await Promise.race([response.json(), timeoutPromise]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerCatalogError(
      boundary === "live" ? "response-invalid" : "metadata-response-invalid",
      providerId,
    );
  }
}

/**
 * Fetches one live provider catalog with a caller-controlled, bounded deadline.
 * Network failures are translated only at this integration boundary; parser `AppError`s pass through.
 */
export async function fetchProviderCatalog(
  options: FetchProviderCatalogOptions,
): Promise<ProviderCatalogModel[]> {
  const { apiKey, fetch, providerId, timeoutMs } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AppError(
      "AGENT_PROVIDER_CATALOG_TIMEOUT_INVALID",
      `Таймаут каталога должен быть целым числом от 1 до ${MAX_TIMEOUT_MS} мс`,
    );
  }

  const endpoint = PROVIDER_ENDPOINTS[providerId];
  const hasApiKey = apiKey !== undefined && apiKey.trim().length > 0;
  if (endpoint.authentication === "required" && !hasApiKey) {
    throw providerCatalogError("auth-required", providerId);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(providerCatalogError("timeout", providerId));
    }, timeoutMs);
  });
  try {
    const liveBody = await fetchJsonWithinDeadline(
      fetch,
      endpoint.url,
      {
        headers: hasApiKey ? { authorization: `Bearer ${apiKey}` } : {},
        method: "GET",
        signal: controller.signal,
      },
      timeoutPromise,
      providerId,
      "live",
    );
    if (providerId === "openrouter") {
      return parseOpenRouterModels(liveBody);
    }

    // Validate availability first, then spend only the remaining deadline on metadata enrichment.
    const liveModels = parseLiveProviderResponse(providerId, liveBody);
    if (providerId === "neuraldeep") return selectSupportedNeuralDeepModels(liveModels);
    const metadataBody = await fetchJsonWithinDeadline(
      fetch,
      MODELS_DEV_URL,
      { headers: {}, method: "GET", signal: controller.signal },
      timeoutPromise,
      providerId,
      "metadata",
    );
    return enrichModelsFromModelsDev(metadataBody, providerId, liveModels);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw providerCatalogError("timeout", providerId);
    }
    throw providerCatalogError("request-failed", providerId);
  } finally {
    clearTimeout(timeout!);
  }
}
