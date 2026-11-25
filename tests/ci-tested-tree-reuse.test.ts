/** #577: a release push to main skips the tests only for code that already passed both suites as is. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const REPOSITORY = "nyxandro/osinara";
const MAIN_BEFORE = "a".repeat(40);
const DEVELOP = "b".repeat(40);
const MERGE = "c".repeat(40);
const TESTED_TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);
const RUN_URL = "https://github.com/nyxandro/osinara/actions/runs/101";
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

interface Scenario {
  headTree?: string;
  developTree?: string;
  runs?: unknown;
  /** Jobs of run 101, or of each run by id; a string is served as is. */
  jobs?: unknown;
  jobsByRun?: Record<number, unknown>;
  apiFails?: boolean;
  jobsApiFails?: boolean;
}

function run(scenario: Scenario) {
  const directory = mkdtempSync(join(tmpdir(), "osinara-tested-tree-"));
  temporary.push(directory);
  const trees: Record<string, string> = {
    HEAD: scenario.headTree ?? TESTED_TREE,
    [MAIN_BEFORE]: OTHER_TREE,
    [DEVELOP]: scenario.developTree ?? TESTED_TREE,
  };
  writeFileSync(join(directory, "git"), `#!/bin/bash
case "$*" in
  "rev-list --parents -n 1 HEAD") echo "${MERGE} ${MAIN_BEFORE} ${DEVELOP}" ;;
${Object.entries(trees).map(([commit, tree]) => `  "rev-parse ${commit}^{tree}") echo "${tree}" ;;`).join("\n")}
  *) echo "unexpected git $*" >&2; exit 2 ;;
esac
`);
  writeFileSync(join(directory, "runs.json"), JSON.stringify(scenario.runs ?? { workflow_runs: [] }));
  for (const [id, jobs] of Object.entries(scenario.jobsByRun ?? { 101: scenario.jobs ?? { jobs: [] } })) {
    writeFileSync(join(directory, `jobs-${id}.json`), typeof jobs === "string" ? jobs : JSON.stringify(jobs));
  }
  writeFileSync(join(directory, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "${directory}/gh-calls"
${scenario.apiFails ? 'echo "HTTP 502: Bad Gateway" >&2; exit 1' : ""}
case "$2" in
  repos/${REPOSITORY}/actions/workflows/ci-release.yaml/runs*) cat "${directory}/runs.json" ;;
  repos/${REPOSITORY}/actions/runs/*/jobs*)
    ${scenario.jobsApiFails ? 'echo "HTTP 500: Internal Server Error" >&2; exit 1' : ""}
    run="\${2#repos/${REPOSITORY}/actions/runs/}"
    cat "${directory}/jobs-\${run%%/*}.json" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(directory, "git"), 0o755);
  chmodSync(join(directory, "gh"), 0o755);
  const output = join(directory, "output");
  writeFileSync(output, "");
  const result = spawnSync("/bin/bash", ["scripts/ci/tested-tree-reuse.sh"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: REPOSITORY },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s, 2)),
  );
  const calls = join(directory, "gh-calls");
  return { result, outputs, ghCalls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

const developPushRun = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  head_sha: DEVELOP,
  event: "push",
  conclusion: "success",
  path: ".github/workflows/ci-release.yaml",
  html_url: RUN_URL,
  head_repository: { full_name: REPOSITORY },
  ...overrides,
});
const bothSuitesPassed = {
  jobs: [
    { name: "Docker Compose test suite", conclusion: "success" },
    { name: "Memory retrieval evals", conclusion: "success" },
    { name: "Publish immutable production release", conclusion: "skipped" },
  ],
};

it("reuses the develop push run that tested the same tree", () => {
  const { result, outputs, ghCalls } = run({ runs: { workflow_runs: [developPushRun()] }, jobs: bothSuitesPassed });
  expect(result.status, result.stderr).toBe(0);
  expect(outputs).toEqual({ reused: "true", "run-url": RUN_URL });
  expect(result.stdout).toContain(`::notice::`);
  expect(result.stdout).toContain(RUN_URL);
  // Only a successful push run of this workflow for that very commit counts.
  expect(ghCalls).toContain(`actions/workflows/ci-release.yaml/runs?head_sha=${DEVELOP}&event=push&status=success`);
});

it("runs the tests when one of the two suites did not pass in that run", () => {
  for (const conclusion of ["skipped", "failure", "cancelled"]) {
    const jobs = { jobs: [bothSuitesPassed.jobs[0], { name: "Memory retrieval evals", conclusion }] };
    const { result, outputs } = run({ runs: { workflow_runs: [developPushRun()] }, jobs });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toEqual({ reused: "false" });
  }
});

it("runs the tests when the merged code differs from every tested parent", () => {
  const { result, outputs, ghCalls } = run({ developTree: OTHER_TREE, runs: { workflow_runs: [developPushRun()] }, jobs: bothSuitesPassed });
  expect(result.status, result.stderr).toBe(0);
  expect(outputs).toEqual({ reused: "false" });
  expect(ghCalls).toBe("");
});

it("ignores a run of another repository, commit, event or workflow", () => {
  for (const override of [
    { head_repository: { full_name: "someone/osinara" } },
    { head_sha: MAIN_BEFORE },
    { event: "pull_request" },
    { conclusion: "failure" },
    { path: ".github/workflows/other.yaml" },
  ]) {
    const { result, outputs } = run({ runs: { workflow_runs: [developPushRun(override)] }, jobs: bothSuitesPassed });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toEqual({ reused: "false" });
  }
});

it("runs the tests with a visible warning when GitHub does not answer", () => {
  const { result, outputs } = run({ apiFails: true });
  expect(result.status, result.stderr).toBe(0);
  expect(outputs).toEqual({ reused: "false" });
  expect(result.stdout).toContain("::warning::");
});

it("runs the tests with a visible warning when the jobs of a run cannot be read", () => {
  for (const scenario of [
    { runs: { workflow_runs: [developPushRun()] }, jobsApiFails: true },
    { runs: { workflow_runs: [developPushRun()] }, jobs: "<html>not json</html>" },
  ]) {
    const { result, outputs } = run(scenario);
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toEqual({ reused: "false" });
    expect(result.stdout).toContain("::warning::");
  }
});

it("goes on to the next run of the same commit when the first one did not pass both suites", () => {
  const rerun = "https://github.com/nyxandro/osinara/actions/runs/102";
  const { result, outputs } = run({
    runs: { workflow_runs: [developPushRun(), developPushRun({ id: 102, html_url: rerun })] },
    jobsByRun: {
      101: { jobs: [bothSuitesPassed.jobs[0], { name: "Memory retrieval evals", conclusion: "failure" }] },
      102: bothSuitesPassed,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(outputs).toEqual({ reused: "true", "run-url": rerun });
});
