/**
 * Closing on-call sessions that finished their work (#428).
 *
 * Constructs covered:
 * - A live session started with the on-call prompt, with the prompt as its only message from a person, that
 *   Claude Code has reported idle for twenty minutes, has its Orca terminal closed.
 * - A session someone went on working in, a busy or recently idle one, and any other Claude Code session stay.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const SCRIPT = new URL("../infra/oncall/close-finished-oncall-sessions.sh", import.meta.url).pathname;
const PROMPT = "Ты дежурный по проекту Osinara. Твоя работа — разобраться, что не так.";
const CWD = "/home/vps/projects/osinara";
const SLUG = "-home-vps-projects-osinara";

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function startTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19]!;
}

/** A stand-in for `claude '<prompt>'`: alive, with the arguments and Orca terminal of a real run. */
function session(home: string, input: {
  args: string[]; firstMessage?: string; handle: string; humanMessages: number; quietMinutes: number; status?: "busy" | "idle";
}) {
  // `--` keeps the stand-in's arguments away from Node's own options, as with `--dangerously-skip-permissions`.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)", "--", ...input.args], {
    env: { ...process.env, ORCA_TERMINAL_HANDLE: input.handle }, stdio: "ignore",
  });
  children.push(child);
  const pid = child.pid!;
  const sessionId = `session-${input.handle}`;
  writeFileSync(join(home, "sessions", `${pid}.json`), JSON.stringify({
    cwd: CWD, kind: "interactive", pid, procStart: startTicks(pid), sessionId,
    status: input.status ?? "idle", statusUpdatedAt: Date.now() - input.quietMinutes * 60_000,
  }));
  const lines = [
    { type: "user", message: { role: "user", content: input.firstMessage ?? PROMPT } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>" } },
    ...Array.from({ length: input.humanMessages - 1 }, () => ({ type: "user", message: { role: "user", content: "продолжим" } })),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Отчёт" }] } },
  ];
  const transcript = join(home, "projects", SLUG, `${sessionId}.jsonl`);
  writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

async function settled(): Promise<void> {
  // The children must have exec'd node before their /proc entries carry the arguments, and must still run.
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const child of children) expect(child.exitCode, "a stand-in session exited early").toBeNull();
}

it("closes only the finished on-call session's terminal", async () => {
  const home = mkdtempSync(join(tmpdir(), "oncall-cleanup-"));
  directories.push(home);
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "projects", SLUG), { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "orca-calls");
  writeFileSync(join(bin, "orca"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
  chmodSync(join(bin, "orca"), 0o755);

  session(home, { args: [PROMPT], handle: "term_finished", humanMessages: 1, quietMinutes: 30 });
  session(home, { args: [PROMPT], handle: "term_continued", humanMessages: 2, quietMinutes: 30 });
  session(home, { args: [PROMPT], handle: "term_recent", humanMessages: 1, quietMinutes: 2 });
  // A long tool call or a subagent keeps the main history quiet while the session works.
  session(home, { args: [PROMPT], handle: "term_busy", humanMessages: 1, quietMinutes: 40, status: "busy" });
  session(home, { args: ["--dangerously-skip-permissions"], handle: "term_owner", humanMessages: 1, quietMinutes: 30 });
  // After `/clear` the process keeps the prompt in its arguments, but the new history is someone else's work.
  session(home, { args: [PROMPT], firstMessage: "поправь вёрстку", handle: "term_cleared", humanMessages: 1, quietMinutes: 30 });
  writeFileSync(join(home, "sessions", "999999999.json"), JSON.stringify({ cwd: CWD, pid: 999999999, procStart: "1", sessionId: "gone" }));
  await settled();

  const result = spawnSync("/bin/bash", [SCRIPT, home], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["terminal close --terminal term_finished --tab --json"]);
  expect(result.stdout).toContain("ONCALL_SESSION_CLOSED");

  // An Orca that cannot close the terminal is reported, never logged as closed.
  writeFileSync(join(bin, "orca"), "#!/bin/bash\nexit 3\n");
  const refused = spawnSync("/bin/bash", [SCRIPT, home], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(refused.status).toBe(1);
  expect(refused.stdout).toContain("ONCALL_SESSION_CLOSE_FAILED");
  expect(refused.stdout).not.toContain("ONCALL_SESSION_CLOSED");
});
