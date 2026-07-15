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
 * - Nginx re-resolves the agent service after Docker replaces its container IP.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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

describe("Docker Compose runtime wiring", () => {
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

  it("pins the multilingual E5 model and bounds its CPU and memory", () => {
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");

    expect(compose).toContain("      - intfloat/multilingual-e5-small\n");
    expect(compose).toContain("      - 614241f622f53c4eeff9890bdc4f31cfecc418b3\n");
    expect(compose).toContain("    mem_limit: 1536m\n");
    expect(compose).toContain("    cpus: 1.5\n");
    expect(compose).toContain("      - --auto-truncate=false\n");
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
    expect(runner).toContain(
      "      - google-workspace-credentials:/runner/google-workspace-credentials\n",
    );
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

    // The native gws binary uses the OS trust store rather than Node's bundled root certificates.
    expect(runtime).toContain("ca-certificates");
    expect(runtime).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("builds every Node application service from the runtime stage", () => {
    const compose = readFileSync(new URL("compose.yaml", projectRoot), "utf8");
    const workerEntrypoints = new Map([
      ["memory-embedding-worker", ".runtime/scripts/memory-embedding-worker.js"],
      ["telegram-ingress-worker", ".runtime/scripts/telegram-ingress-worker.js"],
    ]);

    // An explicit target prevents a later Dockerfile stage, such as Nginx edge, from silently
    // replacing the Node runtime when stages are reordered or appended.
    for (const serviceName of ["agent", "memory-embedding-worker", "telegram-ingress-worker"]) {
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

  it("re-resolves the agent upstream after Docker replaces its container", () => {
    const nginx = readFileSync(new URL("infra/nginx.conf", projectRoot), "utf8");

    // Docker's embedded DNS must be queried after startup; a shared upstream zone lets Nginx
    // replace stale addresses without restarting the public webhook edge.
    expect(nginx).toContain("  resolver 127.0.0.11 valid=10s ipv6=off;\n");
    expect(nginx).toContain("    zone eve_agent 64k;\n");
    expect(nginx).toContain("    server agent:3000 resolve;\n");
  });
});
