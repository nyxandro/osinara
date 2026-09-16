/**
 * Strict production host process and deployment-manifest contracts.
 *
 * Exports:
 * - `releaseEnvironmentFromManifest`: validates schema v1 and emits five fresh-install image refs.
 * - `parseBootstrapProcessOutput`: validates one machine-readable bootstrap process result.
 * - `buildTlsEnvironment` / `parseTlsEnvironment`: exact `/opt/osinara/tls/.env` contract.
 * - `renderTraefikRoute`: hostname substitution for the bundled Traefik route file.
 */
import { z } from "zod";

import type { InstallationExecutionResult, TlsMode } from "./contracts.js";
import { InstallerError } from "./errors.js";

const IMAGE_DIGEST = "[0-9a-f]{64}";
const manifestSchema = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  composeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  images: z.object({
    app: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-app@sha256:${IMAGE_DIGEST}$`, "u")),
    cliProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-cli-proxy@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    edge: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-edge@sha256:${IMAGE_DIGEST}$`, "u")),
    sandboxEgressProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    sandboxRunner: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runner@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    sandboxRuntime: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runtime@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
  }).strict(),
  schemaVersion: z.literal(1),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
}).strict();

const bootstrapSchema = z.object({
  bootstrapCode: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  bootstrapExpiresAt: z.iso.datetime({ offset: false }),
}).strict();

export function releaseEnvironmentFromManifest(
  bytes: Buffer,
  expectedVersion: string,
): Buffer {
  try {
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (manifest.version !== expectedVersion) throw new Error("release version mismatch");
    return Buffer.from([
      `OSINARA_APP_IMAGE=${manifest.images.app}`,
      `OSINARA_EDGE_IMAGE=${manifest.images.edge}`,
      `OSINARA_SANDBOX_EGRESS_PROXY_IMAGE=${manifest.images.sandboxEgressProxy}`,
      `OSINARA_SANDBOX_RUNNER_IMAGE=${manifest.images.sandboxRunner}`,
      `SANDBOX_RUNTIME_IMAGE=${manifest.images.sandboxRuntime}`,
      "",
    ].join("\n"), "utf8");
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_MANIFEST_INVALID",
      "Installation bundle содержит некорректный deployment manifest",
      { cause: error },
    );
  }
}

export function parseBootstrapProcessOutput(bytes: Buffer): InstallationExecutionResult {
  try {
    return bootstrapSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
      "Контейнер не вернул корректный одноразовый код владельца",
      { cause: error },
    );
  }
}

const TLS_MODES: readonly TlsMode[] = ["managed", "external"];
// DNS limits: 63 characters per label, 253 for the whole name.
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const TRAEFIK_HOSTNAME_PLACEHOLDER = '{{ env "OSINARA_HOSTNAME" }}';

export interface TlsEnvironment {
  readonly hostname: string;
  readonly mode: TlsMode;
}

/** Emits the exact two-line TLS env file read by Compose and by the operational commands. */
export function buildTlsEnvironment(input: TlsEnvironment): Buffer {
  if (!HOSTNAME_PATTERN.test(input.hostname) || !TLS_MODES.includes(input.mode)) {
    throw new InstallerError(
      "OSINARA_INSTALL_TLS_ENV_INVALID",
      "Не удалось подготовить TLS config: недопустимое имя хоста или режим публикации",
    );
  }
  return Buffer.from(`OSINARA_HOSTNAME=${input.hostname}\nOSINARA_TLS_MODE=${input.mode}\n`, "utf8");
}

/**
 * Accepts only the exact two-line file: unknown entries and duplicates are rejected, and a missing
 * mode is an operator migration step, not a default.
 */
export function parseTlsEnvironment(bytes: Buffer): TlsEnvironment {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const values = new Map<string, string>();
  for (const line of lines) {
    const entry = /^(OSINARA_HOSTNAME|OSINARA_TLS_MODE)=([^\r\n]+)$/u.exec(line);
    if (!entry || values.has(entry[1]!)) {
      throw new InstallerError(
        "OSINARA_OPERATION_TLS_ENV_INVALID",
        "TLS config должен содержать ровно две строки: OSINARA_HOSTNAME и OSINARA_TLS_MODE",
      );
    }
    values.set(entry[1]!, entry[2]!);
  }
  const hostname = values.get("OSINARA_HOSTNAME");
  const mode = values.get("OSINARA_TLS_MODE");
  if (!hostname || !HOSTNAME_PATTERN.test(hostname)) {
    throw new InstallerError("OSINARA_OPERATION_TLS_ENV_INVALID", "TLS config не содержит корректный hostname");
  }
  if (!mode || !(TLS_MODES as readonly string[]).includes(mode)) {
    throw new InstallerError(
      "OSINARA_OPERATION_TLS_ENV_INVALID",
      "TLS config не содержит OSINARA_TLS_MODE=managed|external; добавьте строку в /opt/osinara/tls/.env",
    );
  }
  return { hostname, mode: mode as TlsMode };
}

/**
 * Substitutes the hostname into the bundled Traefik route so the written file needs no environment:
 * an external proxy never receives `OSINARA_HOSTNAME`, and the managed one does not need it either.
 */
export function renderTraefikRoute(template: Buffer, hostname: string): Buffer {
  const text = template.toString("utf8");
  if (!HOSTNAME_PATTERN.test(hostname) || !text.includes(TRAEFIK_HOSTNAME_PLACEHOLDER)) {
    throw new InstallerError(
      "OSINARA_INSTALL_BUNDLE_ENTRY_INVALID",
      "Installation bundle содержит маршрут Traefik без ожидаемого места для имени хоста",
    );
  }
  return Buffer.from(text.replaceAll(TRAEFIK_HOSTNAME_PLACEHOLDER, hostname), "utf8");
}
