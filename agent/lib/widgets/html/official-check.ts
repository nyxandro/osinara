/**
 * Telegram's official widget check, run on a widget the model wrote as its own HTML.
 *
 * Exports:
 * - `OfficialCheckVerdict`: what refuses the widget and what is only a warning.
 * - `OfficialCheck`: the check, injectable in tests.
 * - `createOfficialCheck`: the check over a command that runs Telegram's harness.
 * - `officialCheck`: the production check, from the copy the image carries.
 * - `readOfficialCheckReport`: Telegram's `--json` report into a verdict.
 *
 * Key constructs:
 * - The owner chose Telegram's own check (F4 of #468). It is widget-sandbox's `sandbox-node.ts`: the
 *   widget runs in Telegram's QuickJS sandbox, without a browser, and the report names what the
 *   profile stripped, every blocked URL and network call, and every script error. The repository has no
 *   licence yet, so its code is not in this repository; the image fetches the pinned release
 *   (`Dockerfile`, stage `widget-check`).
 * - It runs as a child process with a memory cap and a time limit, one at a time: one check takes about
 *   0.8 s and 120 MB (measured 06.11.2026), and the model's code never runs in the agent's process.
 * - A widget the check could not judge is not sent: an unchecked widget could reach a person broken.
 * - The child gets no environment but the path, so the model's code never runs next to the bot token,
 *   the database address or a provider key; its memory cap covers the JavaScript heap, not the
 *   harness's own QuickJS memory, which the harness limits itself.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sema } from "async-sema";

import { AppError } from "../../app-error.js";
import type { HtmlFinding } from "./html-preflight.js";

/** Where the image keeps the pinned copy of widget-sandbox (`Dockerfile`, stage `widget-check`). */
export const OFFICIAL_CHECK_ROOT = "/opt/widget-check";
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_MEMORY_MB = 256;
const REPORT_MAX_BYTES = 2_000_000;
const BREAKING_DIAGNOSTICS = new Set(["network-blocked", "validator:url-blocked"]);

export interface OfficialCheckVerdict {
  readonly refusals: readonly HtmlFinding[];
  readonly warnings: readonly string[];
}

export type OfficialCheck = (html: string) => Promise<OfficialCheckVerdict>;

interface Report {
  diags?: { kind?: unknown; detail?: unknown }[];
  logs?: { level?: unknown; text?: unknown }[];
}

export function readOfficialCheckReport(json: string): OfficialCheckVerdict {
  const report = JSON.parse(json) as Report;
  const refusals: HtmlFinding[] = [];
  const warnings: string[] = [];
  for (const log of report.logs ?? []) {
    if (log.level === "error") refusals.push({ code: "script_error", hint: `a script failed when the widget ran: ${String(log.text).split("\n")[0]}` });
  }
  for (const diagnostic of report.diags ?? []) {
    const kind = String(diagnostic.kind);
    const detail = String(diagnostic.detail);
    if (BREAKING_DIAGNOSTICS.has(kind)) refusals.push({ code: kind, hint: `Telegram blocks this in a widget: ${detail}` });
    else if (kind === "validator:profile" && /^<[a-z0-9-]+> dropped$/iu.test(detail)) refusals.push({ code: "element_dropped", hint: `Telegram removes this element: ${detail}` });
    else warnings.push(`${kind}: ${detail}`);
  }
  return { refusals, warnings };
}

function unavailable(reason: string, cause?: unknown): AppError {
  console.error(JSON.stringify({
    code: "AGENT_WIDGET_HTML_CHECK_UNAVAILABLE",
    ...(cause === undefined ? {} : { error: cause instanceof Error ? cause.message : String(cause) }),
    reason,
  }));
  return new AppError("AGENT_WIDGET_HTML_CHECK_UNAVAILABLE", "Проверка виджета не ответила, виджет не отправлен", {
    ...(cause === undefined ? {} : { cause }),
    details: { reason },
  });
}

export function createOfficialCheck(command: { readonly cwd: string; readonly argv: (file: string) => readonly string[] }): OfficialCheck {
  const slot = new Sema(1);
  return async (html) => {
    await slot.acquire();
    const folder = await mkdtemp(join(tmpdir(), "widget-check-"));
    try {
      const file = join(folder, "widget.html");
      await writeFile(file, html, "utf8");
      const [program, ...args] = command.argv(file);
      const output = await new Promise<string>((resolve, reject) => {
        // None of the application's secrets go to a process that runs the model's code: only the path.
        const env = process.env.PATH === undefined ? {} : { PATH: process.env.PATH };
        const child = spawn(program!, args, { cwd: command.cwd, env, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(unavailable("timeout"));
        }, CHECK_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > REPORT_MAX_BYTES) child.kill("SIGKILL");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(unavailable("spawn", error));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(unavailable(`exit ${String(code)}`));
        });
      });
      try {
        return readOfficialCheckReport(output);
      } catch (error) {
        throw unavailable("report", error);
      }
    } finally {
      await rm(folder, { force: true, recursive: true });
      slot.release();
    }
  };
}

export const officialCheck = createOfficialCheck({
  // One process under the memory cap: tsx as an import hook, not its CLI, which would start a second one.
  argv: (file) => [process.execPath, `--max-old-space-size=${CHECK_MEMORY_MB}`, "--import", "tsx", "scripts/sandbox-node.ts", file, "--json"],
  cwd: OFFICIAL_CHECK_ROOT,
});
