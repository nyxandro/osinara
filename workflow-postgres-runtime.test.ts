/**
 * PostgreSQL Workflow world deployment contracts.
 *
 * Tests:
 * - Pins Eve and the protocol-compatible official PostgreSQL world: the history import reads Eve's
 *   database until phase B removes it.
 * - Keeps Workflow credentials fail-fast and isolated to the agent and migration service.
 * - Removes the local-world mount while retaining its rollback snapshot during cutover.
 * - Runs official Workflow bootstrap before application migrations.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const readProjectFile = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("PostgreSQL Workflow world", () => {
  it("pins Eve and the Eve-compatible official world", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.eve).toBe("0.40.0");
    expect(packageJson.dependencies?.["@workflow/world-postgres"]).toBe("5.0.0-beta.35");
  });

  it.each(["compose.yaml", "compose.production.yaml"])(
    "%s selects PostgreSQL without mounting local-world state",
    (path) => {
      const compose = readProjectFile(path);

      expect(compose).toContain(
        "WORKFLOW_POSTGRES_URL: ${WORKFLOW_POSTGRES_URL:?WORKFLOW_POSTGRES_URL is required}",
      );
      expect(compose).not.toContain("/app/.eve/.workflow-data");
      expect(compose).not.toMatch(/^  eve-workflow-data:/mu);
    },
  );

  it("gives Workflow credentials only to services that need them", () => {
    const compose = readProjectFile("compose.production.yaml");
    const agent = compose.slice(
      compose.indexOf("\n  agent:\n"),
      compose.indexOf("\n  migrate:\n"),
    );
    const migrate = compose.slice(
      compose.indexOf("\n  migrate:\n"),
      compose.indexOf("\n  memory-embedding-worker:\n"),
    );
    const workers = compose.slice(compose.indexOf("\n  memory-embedding-worker:\n"));

    expect(agent).toContain("WORKFLOW_POSTGRES_URL:");
    expect(migrate).toContain("WORKFLOW_POSTGRES_URL:");
    expect(workers).not.toContain("WORKFLOW_POSTGRES_URL:");
  });

  it("bootstraps Workflow schema before application migrations", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const compose = readProjectFile("compose.production.yaml");

    expect(packageJson.scripts?.migrate).toContain("migrate-workflow");
    expect(compose).toContain('entrypoint: ["npm", "run", "migrate:runtime"]');
  });

  it("ships a deterministic 300-turn PostgreSQL stress gate", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const stressEval = readProjectFile(
      "stress/workflow-postgres/evals/retention.eval.ts",
    );

    expect(packageJson.scripts?.["test:workflow-stress"]).toContain("workflow-postgres-stress");
    expect(stressEval).toContain("const STRESS_TURN_COUNT = 300;");
    expect(stressEval).toContain("side_effect_count");
    expect(stressEval).toContain("workflow_event_count");
  });

  it("generates a dedicated Workflow connection and preserves the v0.32 volume for rollback", () => {
    const installer = readProjectFile("scripts/provider-installer/host-executor.ts");
    const backup = readProjectFile("scripts/production-deploy/backup.sh");

    expect(installer).toContain('"WORKFLOW_POSTGRES_URL",');
    expect(installer).toContain("/osinara_workflow`");
    expect(backup).toContain("PRESERVED_WORKFLOW_CUTOVER_VOLUME");
    expect(backup).toContain("workflow-postgres.dump");
    expect(backup).not.toContain(
      'docker volume rm "$PRESERVED_WORKFLOW_CUTOVER_VOLUME"',
    );
  });
});
