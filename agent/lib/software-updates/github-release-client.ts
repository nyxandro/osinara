/**
 * Unauthenticated public GitHub release and deployment-manifest client.
 *
 * Exports:
 * - `GitHubSoftwareReleaseClient`: latest accepted release lookup contract.
 * - `createGitHubSoftwareReleaseClient`: bounded, no-retry GitHub client factory.
 * - `githubSoftwareReleaseClient`: production client for nyxandro/osinara.
 */
import { z } from "zod";

import {
  SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES,
  SOFTWARE_UPDATE_HTTP_TIMEOUT_MS,
  SOFTWARE_UPDATE_MANIFEST_MAX_BYTES,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { compareSemver, stableVersionFromTag } from "./semver.js";
import type { SoftwareRelease, SoftwareUpdateManifest } from "./types.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/nyxandro/osinara/releases/latest";
const MANIFEST_ASSET_NAME = "osinara-deployment.json";
const GITHUB_API_VERSION = "2026-03-10";
const IMAGE_DIGEST = "[0-9a-f]{64}";

const releaseSchema = z.object({
  assets: z.array(z.object({
    browser_download_url: z.url(),
    name: z.string(),
    state: z.string(),
  })),
  draft: z.boolean(),
  html_url: z.url(),
  immutable: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string(),
});

const manifestSchema = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  composeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  images: z.object({
    app: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-app@sha256:${IMAGE_DIGEST}$`)),
    cliProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-cli-proxy@sha256:${IMAGE_DIGEST}$`),
    ),
    edge: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-edge@sha256:${IMAGE_DIGEST}$`)),
    sandboxEgressProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${IMAGE_DIGEST}$`),
    ),
    sandboxRunner: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runner@sha256:${IMAGE_DIGEST}$`),
    ),
    sandboxRuntime: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runtime@sha256:${IMAGE_DIGEST}$`),
    ),
  }).strict(),
  schemaVersion: z.literal(1),
  version: z.string(),
}).strict();

export interface GitHubSoftwareReleaseClient {
  latestNewerThan(currentVersion: string): Promise<SoftwareRelease | null>;
}

interface GitHubSoftwareReleaseClientDependencies {
  fetch: typeof fetch;
  timeoutMs: number;
}

async function responseJson(
  response: Response,
  maxBytes: number,
  code: string,
  message: string,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) throw new AppError(code, message);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    // Stop reading at the limit even when an external server omits Content-Length.
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        reader.releaseLock();
        throw new AppError(code, message);
      }
      chunks.push(chunk.value);
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.error(JSON.stringify({
      code,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof Error) error.message = `${code}: ${message}`;
    throw error;
  }
}

function requireRepositoryUrl(value: string, expectedPath: string, code: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new AppError(code, "GitHub вернул ссылку на релиз из неожиданного источника");
  }
  return value;
}

export function createGitHubSoftwareReleaseClient(
  dependencies: GitHubSoftwareReleaseClientDependencies,
): GitHubSoftwareReleaseClient {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_TIMEOUT_INVALID",
      "Тайм-аут проверки обновлений должен быть положительным целым числом",
    );
  }

  async function request(url: string, maxBytes: number, code: string, message: string) {
    // Every endpoint is called exactly once with its own bounded signal and no authorization header.
    const response = await dependencies.fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "osinara-software-update-checker",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(dependencies.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError(
        "AGENT_SOFTWARE_RELEASE_REQUEST_FAILED",
        `GitHub не выполнил проверку обновлений (HTTP ${response.status})`,
      );
    }
    return responseJson(response, maxBytes, code, message);
  }

  return {
    async latestNewerThan(currentVersion) {
      const releaseJson = await request(
        LATEST_RELEASE_URL,
        SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES,
        "AGENT_SOFTWARE_RELEASE_INVALID",
        "GitHub вернул некорректные данные последнего релиза",
      );
      const parsedRelease = releaseSchema.safeParse(releaseJson);
      if (!parsedRelease.success) {
        throw new AppError(
          "AGENT_SOFTWARE_RELEASE_INVALID",
          "GitHub вернул некорректные данные последнего релиза",
        );
      }
      const release = parsedRelease.data;
      const version = stableVersionFromTag(release.tag_name);
      if (!release.immutable || release.draft || release.prerelease || !version) return null;
      if (compareSemver(version, currentVersion) <= 0) return null;

      // The public URL and unique uploaded asset are constrained to this exact repository and tag.
      const releaseUrl = requireRepositoryUrl(
        release.html_url,
        `/nyxandro/osinara/releases/tag/${release.tag_name}`,
        "AGENT_SOFTWARE_RELEASE_URL_INVALID",
      );
      const assets = release.assets.filter((asset) =>
        asset.name === MANIFEST_ASSET_NAME && asset.state === "uploaded"
      );
      if (assets.length !== 1) {
        throw new AppError(
          "AGENT_SOFTWARE_MANIFEST_ASSET_INVALID",
          "Релиз должен содержать один готовый манифест osinara-deployment.json",
        );
      }
      const assetUrl = requireRepositoryUrl(
        assets[0]!.browser_download_url,
        `/nyxandro/osinara/releases/download/${release.tag_name}/${MANIFEST_ASSET_NAME}`,
        "AGENT_SOFTWARE_MANIFEST_ASSET_INVALID",
      );
      const manifestJson = await request(
        assetUrl,
        SOFTWARE_UPDATE_MANIFEST_MAX_BYTES,
        "AGENT_SOFTWARE_MANIFEST_INVALID",
        "Манифест обновления имеет некорректный формат",
      );
      const parsedManifest = manifestSchema.safeParse(manifestJson);
      if (!parsedManifest.success || parsedManifest.data.version !== version) {
        throw new AppError(
          "AGENT_SOFTWARE_MANIFEST_INVALID",
          "Версия, Compose-файл или образы в манифесте обновления не прошли проверку",
        );
      }
      return {
        manifest: parsedManifest.data as SoftwareUpdateManifest,
        releaseUrl,
        version,
      };
    },
  };
}

export const githubSoftwareReleaseClient = createGitHubSoftwareReleaseClient({
  fetch,
  timeoutMs: SOFTWARE_UPDATE_HTTP_TIMEOUT_MS,
});
