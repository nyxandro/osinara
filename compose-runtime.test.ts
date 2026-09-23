/**
 * Docker Compose runtime wiring regression tests.
 *
 * Constructs covered:
 * - Eve Workflow queue namespace is available before the local world starts.
 * - Local E5 runtime is immutable and resource bounded.
 * - Removed antivirus infrastructure cannot return to the runtime.
 * - PDF processing stays inside the normal sandbox instead of a parallel service.
 * - Docker socket, runner control plane, egress proxy, tools, and Google credentials remain isolated.
 * - Native skill package assets are shipped in the production agent image.
 * - Production agent runtime includes system CA roots for native integration binaries.
 * - Node application services explicitly select the production runtime image stage.
 * - Agent containers map one selected-provider secret into the provider-neutral runtime boundary.
 * - The controller-compatible retired memory worker exposes stabilized readiness without work.
 * - Nginx re-resolves the agent service after Docker replaces its container IP.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MEMORY_EMBEDDING_WORKER_READY_PATH,
  MEMORY_EMBEDDING_WORKER_STALE_MILLISECONDS,
  MEMORY_EXTRACTION_WORKER_READY_PATH,
  MEMORY_EXTRACTION_WORKER_STABILITY_MILLISECONDS,
} from "./agent/lib/memory-config.js";

interface PackageManifest {
  name: string;
}

const projectRoot = new URL("./", import.meta.url);
const REMOVED_DOCUMENT_PARSER_PATHS = [
  "agent/lib/attachments/document-parser-client.ts",
  "agent/lib/workspaces/workspace-pdf-inspection.ts",
  "agent/tools/inspect_workspace_pdf.ts",
  "services/document-parser/server.mjs",
] as const;
const REMOVED_ANTIVIRUS_PATHS = [
  "agent/lib/attachments/clamav-scanner.ts",
  "agent/lib/attachments/clamav-scanner.test.ts",
] as const;

/**
 * Peak resident memory of the embedding service under a saturating load, measured on a six-core
 * host with the pinned image and model. Memory is set by the number of math threads and barely
 * moves with the CPU budget: two and three cores differed by eleven megabytes, one and three math
 * threads by four hundred. Three threads do not fit a gigabyte at all — the container is killed
 * while it is still loading the model.
 */
const MEASURED_PEAK_MEGABYTES: Readonly<Record<number, number>> = { 1: 820, 2: 870, 3: 1250 };

interface EmbeddingService {
  clientBatchSize: number;
  concurrentRequests: number;
  cpus: number;
  mathThreads: number;
  memoryLimitMegabytes: number;
}

function embeddingService(file: string): EmbeddingService {
  const compose = readFileSync(new URL(file, projectRoot), "utf8");
  const start = compose.indexOf("\n  memory-embedding:\n");
  const rest = compose.slice(start + 1);
  const next = rest.indexOf("\n  memory-");
  const block = next === -1 ? rest : rest.slice(0, next);
  const flag = (name: string) => {
    const value = block.match(new RegExp(`- --${name}\\n\\s+- "?(\\d+)"?`, "u"))?.[1];
    if (value === undefined) throw new Error(`${file}: --${name} is not set on memory-embedding`);
    return Number(value);
  };
  const setting = (pattern: RegExp, name: string) => {
    const value = block.match(pattern)?.[1];
    if (value === undefined) throw new Error(`${file}: ${name} is not set on memory-embedding`);
    return Number(value);
  };
  return {
    clientBatchSize: flag("max-client-batch-size"),
    concurrentRequests: flag("max-concurrent-requests"),
    cpus: setting(/\bcpus: (\d+(?:\.\d+)?)/u, "cpus"),
    mathThreads: setting(/OMP_NUM_THREADS: "(\d+)"/u, "OMP_NUM_THREADS"),
    memoryLimitMegabytes: setting(/mem_limit: (\d+)m/u, "mem_limit"),
  };
}

/** Top-level service block of a Compose file, up to the next service at the same indentation. */
function serviceBlock(file: string, name: string): string {
  const compose = readFileSync(new URL(file, projectRoot), "utf8");
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`${file}: service ${name} is missing`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z0-9._-]+:\n/u);
  return `${next === -1 ? rest : rest.slice(0, next + 1)}\n`;
}

/** A size key in megabytes; a key written in any other form fails instead of being skipped. */
function megabytes(block: string, key: string): number | undefined {
  const line = block.match(new RegExp(`\\n {4}${key}: (.+)\\n`, "u"))?.[1];
  if (line === undefined) return undefined;
  const value = line.match(/^(\d+)m$/u)?.[1];
  if (value === undefined) throw new Error(`${key}: ${line} is not written in megabytes`);
  return Number(value);
}

const PROTECTED_SERVICES = ["postgres", "agent", "memory-embedding"] as const;

describe("Docker Compose runtime wiring", () => {
  it("wires the agent to a healthy persistent Codex subscription gateway", () => {
    const localCompose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");
    const productionCompose = readFileSync(new URL("compose.production.yaml", projectRoot), "utf8");
    for (const compose of [localCompose, productionCompose]) {
      const agent = compose.slice(
        compose.indexOf("\n  agent:\n"),
        compose.indexOf("\n  sandbox-runtime-image:\n"),
      );
      expect(agent).toContain(
        "      MODEL_API_KEY: ${MODEL_API_KEY:?MODEL_API_KEY is required}\n",
      );
      expect(agent).toContain("      GROQ_API_KEY: ${GROQ_API_KEY-}\n");
    }
    expect(localCompose).not.toContain("MODEL_UPSTREAM_API_KEY");
    expect(productionCompose).not.toContain("MODEL_UPSTREAM_API_KEY");
    for (const compose of [localCompose, productionCompose]) {
      expect(compose).toContain("cli-proxy-auth:/var/lib/cli-proxy-api/auth\n");
    }
    const productionAgent = productionCompose.slice(
      productionCompose.indexOf("\n  agent:\n"),
      productionCompose.indexOf("\n  sandbox-runtime-image:\n"),
    );
    expect(productionAgent).toContain("cli-proxy-api:\n        condition: service_healthy");
    expect(localCompose).toContain('    profiles: ["codex-subscription"]\n');
    expect(productionCompose).toContain(
      "- /opt/osinara/agent-model-providers.json:/app/config/agent-model-providers.json:ro",
    );
    expect(productionCompose).not.toContain("/opt/osinara/model-providers.json");
  });

  it("provides Eve's derived queue namespace before workflow recovery starts", () => {
    // Eve derives the queue namespace from the package name after loading the agent bundle.
    // Compose must provide the same value earlier so local-world recovery targets registered queues.
    const packageManifest = JSON.parse(
      readFileSync(new URL("package.json", projectRoot), "utf8"),
    ) as PackageManifest;
    const expectedNamespace = `eve${Buffer.from(packageManifest.name, "utf8").toString("hex")}`;
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");

    expect(compose).toContain(`      WORKFLOW_QUEUE_NAMESPACE: ${expectedNamespace}\n`);
  });

  it.each(["compose.yaml", "compose.production.yaml"])(
    "pins the multilingual E5 model in %s",
    (file) => {
      const compose = readFileSync(new URL(file, projectRoot), "utf8");

      expect(compose).toContain("      - intfloat/multilingual-e5-small\n");
      expect(compose).toContain("      - 614241f622f53c4eeff9890bdc4f31cfecc418b3\n");
      expect(compose).toContain("      - --auto-truncate=false\n");
    },
  );

  it.each(["compose.yaml", "compose.production.yaml"])(
    "leaves room in %s for a client batch and the searches beside it",
    (file) => {
      const service = embeddingService(file);

      // A client batch occupies one queue slot per input. At a limit equal to the batch size one
      // indexing batch fills the queue, and a search arriving beside it is refused outright rather
      // than queued: the turn loses its semantic branch and the person sees forgetfulness. Measured
      // on a saturating indexer, a limit equal to the batch refused 15 searches out of 60; twice
      // the batch refused none.
      expect(service.concurrentRequests).toBeGreaterThanOrEqual(2 * service.clientBatchSize);
    },
  );

  it.each(["compose.yaml", "compose.production.yaml"])(
    "gives %s a core beyond the math threads for tokenization and intake",
    (file) => {
      const service = embeddingService(file);

      // On one core an indexing batch held the service for 2.8 seconds and a search arriving then
      // waited behind it, 5 to 22 seconds against a 30-second client ceiling. Tokenization and
      // request intake need a core the math threads do not occupy.
      expect(service.cpus).toBeGreaterThan(service.mathThreads);
    },
  );

  it.each(["compose.yaml", "compose.production.yaml"])(
    "keeps the memory limit in %s above what its thread count needs",
    (file) => {
      const service = embeddingService(file);
      const peak = MEASURED_PEAK_MEGABYTES[service.mathThreads];

      expect(peak, `no measurement for ${service.mathThreads} math threads`).toBeDefined();
      // Raising threads without raising the limit does not degrade: the container never finishes
      // loading the model, and semantic search is gone until someone reads the logs.
      expect(service.memoryLimitMegabytes).toBeGreaterThanOrEqual(Math.ceil(peak! * 1.15));
    },
  );

  it.each(PROTECTED_SERVICES)(
    "protects the working memory of production %s from neighbours on the host",
    (name) => {
      const block = serviceBlock("compose.production.yaml", name);
      const reservation = megabytes(block, "mem_reservation");
      const limit = megabytes(block, "mem_limit");

      // Development shares this host. Under its peaks the kernel reclaimed the bot as readily as
      // the tests, the database stopped accepting connections within five seconds and three times
      // restarted itself (#253). mem_reservation becomes cgroup memory.low: what the service holds
      // below it is taken only once every unprotected neighbour has given up its share.
      expect(reservation, `${name} has no mem_reservation`).toBeDefined();
      expect(reservation!).toBeGreaterThan(0);
      if (limit !== undefined) expect(reservation!).toBeLessThan(limit);
    },
  );

  it("keeps every production service in the slice the host protects, sized to the reservations", () => {
    const compose = readFileSync(new URL("compose.production.yaml", projectRoot), "utf8");
    const services = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nvolumes:\n"));
    const names = [...services.matchAll(/\n {2}([a-zA-Z0-9._-]+):\n/gu)].map((match) => match[1]!);
    const deployGuide = readFileSync(new URL("docs/production-deployment.md", projectRoot), "utf8");

    // A reservation counts only up to what its parent protects. Outside osinara.slice a service
    // would sit in system.slice, whose protection is zero, and share any surplus with development.
    for (const name of names) {
      expect(serviceBlock("compose.production.yaml", name), name).toContain("\n    cgroup_parent: osinara.slice\n");
    }
    // The host setting is typed by hand from the guide; the sum keeps the two from drifting apart.
    const total = PROTECTED_SERVICES
      .map((name) => megabytes(serviceBlock("compose.production.yaml", name), "mem_reservation")!)
      .reduce((sum, value) => sum + value, 0);
    expect(deployGuide).toContain(`systemctl set-property osinara.slice MemoryLow=${total}M`);
  });

  it("keeps antivirus and the separate document parser out of the runtime", () => {
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");
    const dockerfile = readFileSync(new URL("Dockerfile", projectRoot), "utf8");

    expect(compose.toLowerCase()).not.toContain("clamav");
    expect(compose).not.toContain("attachment-scanning");
    expect(compose).toContain("    read_only: true\n");
    expect(compose).toContain("      - no-new-privileges:true\n");
    expect(compose).not.toContain("document-parser");
    expect(compose).not.toContain("document-processing");
    expect(dockerfile).not.toContain("AS document-parser");
    expect(dockerfile).toContain("      poppler-utils \\\n");

    // Keep the removed parallel processing path out of the production source tree.
    for (const removedPath of REMOVED_DOCUMENT_PARSER_PATHS) {
      expect(existsSync(new URL(removedPath, projectRoot)), removedPath).toBe(false);
    }
    for (const removedPath of REMOVED_ANTIVIRUS_PATHS) {
      expect(existsSync(new URL(removedPath, projectRoot)), removedPath).toBe(false);
    }
  });

  it("keeps Docker control out of the agent and sandbox egress out of the app network", () => {
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");
    const agent = compose.slice(
      compose.indexOf("\n  agent:\n"),
      compose.indexOf("\n  sandbox-runtime-image:\n"),
    );
    const runnerStart = compose.lastIndexOf("\n  sandbox-runner:\n");
    const runner = compose.slice(
      runnerStart,
      compose.indexOf("\n  sandbox-egress-proxy:\n", runnerStart),
    );

    expect(agent).not.toContain("/var/run/docker.sock");
    expect(runner).toContain("      - /var/run/docker.sock:/var/run/docker.sock\n");
    expect(agent).toContain(
      "      - google-workspace-credentials:/app/google-workspace-credentials\n",
    );
    expect(runner).not.toContain("google-workspace-credentials");
    expect(runner).toContain("      - tool-environments:/runner/tools\n");
    expect(runner).toContain("      - sandbox-control\n");
    expect(runner).not.toContain("      - sandbox-egress\n");
    expect(compose).toContain("  sandbox-control:\n    internal: true\n");
    expect(compose).toContain("  sandbox-egress:\n    internal: true\n");
  });

  it("ships native skill package assets in the production runtime", () => {
    const dockerfile = readFileSync(new URL("Dockerfile", projectRoot), "utf8");

    expect(dockerfile).toContain("COPY --from=build /app/agent ./agent\n");
    expect(dockerfile).not.toContain("COPY --from=build /app/resources ./resources\n");
  });

  it("installs system CA roots in the production agent runtime", () => {
    const dockerfile = readFileSync(new URL("Dockerfile", projectRoot), "utf8");
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM first-party-node AS runtime"),
      dockerfile.indexOf("FROM nginx:", dockerfile.indexOf("FROM first-party-node AS runtime")),
    );

    // OAuth refresh and other HTTPS boundaries require the OS trust store in production.
    expect(runtime).toContain("ca-certificates");
    expect(runtime).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("builds every Node application service from the runtime stage", () => {
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");
    const workerEntrypoints = new Map([
      ["memory-embedding-worker", ".runtime/scripts/memory-embedding-worker.js"],
      ["memory-extraction-worker", ".runtime/scripts/memory-extraction-worker.js"],
      ["telegram-ingress-worker", ".runtime/scripts/telegram-ingress-worker.js"],
    ]);

    // An explicit target prevents a later Dockerfile stage, such as Nginx edge, from silently
    // replacing the Node runtime when stages are reordered or appended.
    for (const serviceName of [
      "agent", "memory-embedding-worker", "memory-extraction-worker", "telegram-ingress-worker",
    ]) {
      const serviceStart = compose.indexOf(`\n  ${serviceName}:\n`);
      const nextServiceOffset = compose.slice(serviceStart + 1).search(/\n  \S/);
      const serviceEnd = nextServiceOffset === -1
        ? undefined
        : serviceStart + nextServiceOffset + 1;
      const service = compose.slice(serviceStart, serviceEnd);

      expect(service, serviceName).toContain("      target: runtime\n");
      const workerEntrypoint = workerEntrypoints.get(serviceName);
      if (workerEntrypoint) {
        expect(service, serviceName).toContain(
          `    entrypoint: ["node", "${workerEntrypoint}"]\n`,
        );
      }
    }
  });

  it("lets a hung indexing worker become an unhealthy container", () => {
    // A live process doing nothing is the one failure this worker had no signal for: it exits
    // nothing, logs nothing, and the memories it should have indexed simply stop being findable.
    const compose = readFileSync(new URL("compose.production.yaml", projectRoot), "utf8");
    const serviceStart = compose.indexOf("\n  memory-embedding-worker:\n");
    const nextServiceOffset = compose.slice(serviceStart + 1).search(/\n  \S/u);
    const worker = compose.slice(
      serviceStart,
      nextServiceOffset === -1 ? undefined : serviceStart + nextServiceOffset + 1,
    );
    const workerScript = readFileSync(
      new URL("scripts/memory-embedding-worker.ts", projectRoot), "utf8",
    );

    expect(serviceStart).toBeGreaterThanOrEqual(0);
    expect(worker).toContain("healthcheck:");
    expect(worker).toContain(MEMORY_EMBEDDING_WORKER_READY_PATH);
    expect(worker).toContain(String(MEMORY_EMBEDDING_WORKER_STALE_MILLISECONDS));
    expect(workerScript).toContain("MEMORY_EMBEDDING_WORKER_READY_PATH");
    expect(workerScript).toContain("MEMORY_EMBEDDING_WORKER_STARTED_CODE");
  });

  it("keeps a controller-compatible memory worker without extraction or provider calls", () => {
    const composeFiles = ["compose.yaml", "compose.test.yaml", "compose.production.yaml"];
    const workerScript = readFileSync(new URL("scripts/memory-extraction-worker.ts", projectRoot), "utf8");

    for (const composeFile of composeFiles) {
      const compose = readFileSync(new URL(composeFile, projectRoot), "utf8");
      const serviceStart = compose.indexOf("\n  memory-extraction-worker:\n");
      const nextServiceOffset = compose.slice(serviceStart + 1).search(/\n  \S/u);
      const serviceEnd = nextServiceOffset === -1
        ? undefined
        : serviceStart + nextServiceOffset + 1;
      const worker = compose.slice(serviceStart, serviceEnd);

      expect(serviceStart, `${composeFile} worker is absent`).toBeGreaterThanOrEqual(0);
      expect(worker, composeFile).toContain("network_mode: none");
      expect(worker, composeFile).not.toContain("DATABASE_URL");
      expect(worker, composeFile).not.toContain("MEMORY_EMBEDDING_BASE_URL");
      expect(worker, composeFile).not.toContain("MODEL_UPSTREAM_API_KEY");
      expect(worker, composeFile).toContain("healthcheck:");
      expect(worker, composeFile).toContain(MEMORY_EXTRACTION_WORKER_READY_PATH);
      expect(worker, composeFile).toContain(String(MEMORY_EXTRACTION_WORKER_STABILITY_MILLISECONDS));
    }
    expect(workerScript).toContain("MEMORY_EXTRACTION_WORKER_READY_PATH");
    expect(workerScript).not.toContain("processNextMemoryExtraction");
    expect(workerScript).not.toContain("model-registry");
    expect(workerScript).not.toContain('from "../agent/lib/database.js"');
    expect(workerScript).toContain("processNext: async () => false");
  });

  it("re-resolves the agent upstream after Docker replaces its container", () => {
    const nginx = readFileSync(new URL("infra/nginx.conf", projectRoot), "utf8");

    // Docker's embedded DNS must be queried after startup; a shared upstream zone lets Nginx
    // replace stale addresses without restarting the public webhook edge.
    expect(nginx).toContain("  resolver 127.0.0.11 valid=10s ipv6=off;\n");
    expect(nginx).toContain("    zone eve_agent 64k;\n");
    expect(nginx).toContain("    server agent:3000 resolve;\n");
  });
});
