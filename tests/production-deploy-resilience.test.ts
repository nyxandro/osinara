/**
 * A short GitHub outage does not fail an update, and nothing after a recorded success tells the owner
 * that the update failed.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

const projectRoot = new URL("../", import.meta.url);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** Answers each request with the next status; the last one repeats. */
async function githubStandIn(statuses: number[]): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    const status = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    response.writeHead(status).end(status === 200 ? "{}" : "gateway");
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits: () => hits };
}

/** The deploy's own GitHub request; only the scheme and the pause between attempts are shortened. */
function curlGithub(url: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("/bin/bash", ["-c", `set -euo pipefail
source scripts/production-deploy/release.sh
curl_github --proto '=http' --noproxy '*' --retry-delay 1 --output /dev/null ${JSON.stringify(url)}`], {
      cwd: projectRoot,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (status) => done({ status, stderr }));
  });
}

it("rides out GitHub answering 504 and says so in the deploy journal", async () => {
  const github = await githubStandIn([504, 504, 200]);
  const result = await curlGithub(github.url);
  expect(result.status, result.stderr).toBe(0);
  expect(github.hits()).toBe(3);
  expect(result.stderr).toContain("Will retry");
}, 30_000);

it("does not repeat a request GitHub refused for good", async () => {
  const github = await githubStandIn([404]);
  const result = await curlGithub(github.url);
  expect(result.status).toBe(22);
  expect(github.hits()).toBe(1);
}, 30_000);

it("waits out a GitHub outage of minutes, not seconds, and shows each retry", () => {
  const release = readFileSync(new URL("scripts/production-deploy/release.sh", projectRoot), "utf8");
  const curlGithubSource = release.slice(release.indexOf("curl_github() {"), release.indexOf("\n}\n", release.indexOf("curl_github() {")));
  // 25.11.2026 02:40-02:44 UTC GitHub's API answered 504 for about four minutes (#577).
  expect(curlGithubSource).toContain("--retry 10 --retry-delay 30 --retry-max-time 300");
  // --silent would hide curl's "Will retry" lines; errors and warnings stay, the progress meter goes.
  expect(curlGithubSource).toContain("--no-progress-meter");
  expect(curlGithubSource).not.toContain("--silent");
});

function failureAfter(state: string) {
  const main = readFileSync(new URL("scripts/production-deploy/main.sh", projectRoot), "utf8");
  const handler = main.slice(main.indexOf("handle_failure() {"), main.indexOf("handle_signal() {"));
  return spawnSync("/bin/bash", ["-c", `
REQUESTED_VERSION=0.82.1
PROPOSAL_ID=11111111-1111-4111-8111-111111111111
FAILURE_HANDLING=0
MIGRATION_STARTED=1
CURRENT_SERVICES_STOPPED=0
TERMINAL_RECORDED=0
RELEASE_SUCCEEDED=0
${state}
log_event() { printf 'event %s %s\\n' "$1" "$2"; }
record_proposal_result() { printf 'record %s\\n' "$1"; }
send_telegram_notification() { printf 'telegram %s\\n' "$1"; }
restart_current_release() { printf 'restart\\n'; }
cleanup_created_candidate_volumes() { :; }
cleanup_incomplete_backup() { :; }
resume_runtime_admission() { :; }
${handler}
handle_failure 1 250 "command failed"`], { cwd: projectRoot, encoding: "utf8" });
}

it("only logs a cleanup step that fails after the owner was told the update succeeded", () => {
  const result = failureAfter("TERMINAL_RECORDED=1; RELEASE_SUCCEEDED=1");
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("event DEPLOY_POST_SUCCESS_STEP_FAILED");
  expect(result.stdout).toContain("v0.82.1");
  expect(result.stdout).not.toContain("telegram");
  expect(result.stdout).not.toContain("record");
});

it("still reports a migration that failed before any success was recorded", () => {
  const result = failureAfter("");
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("record ambiguous");
  expect(result.stdout).toContain("telegram Не удалось однозначно завершить обновление v0.82.1");
});
