/**
 * Checks of a widget the model wrote as its own HTML.
 *
 * Constructs covered:
 * - The quick check refuses what breaks a widget, with a hint each, and leaves plain words alone.
 * - Telegram's report (recorded from widget-sandbox v0.6.1 on 06.11.2026) refuses script errors,
 *   blocked URLs, network calls and dropped elements, and keeps stripped styling as warnings.
 * - The check runs as a child process: its report is read, a hang and a crash are "unavailable".
 */
import { describe, expect, it } from "vitest";

import { createOfficialCheck, readOfficialCheckReport } from "./official-check.js";
import { preflightHtmlWidget } from "./html-preflight.js";

const GAME = `<style>body{margin:0;padding:12px}button{width:30%}</style><div id="b"></div>
<script>const b=document.getElementById('b');for(let i=0;i<9;i++){const c=document.createElement('button');c.textContent='·';c.onclick=()=>{c.textContent='X'};b.append(c)}</script>
<p>Нажмите fetch, если хотите — это просто слово.</p>`;

/** The report Telegram's harness gave for a widget with an input, a remote image, fetch and a broken call. */
const BROKEN_REPORT = JSON.stringify({
  diags: [
    { detail: "<input> dropped", kind: "validator:profile" },
    { detail: "img[src]=https://example.com/a.png", kind: "validator:url-blocked" },
    { detail: "font-family: \"Roboto\"", kind: "validator:profile" },
    { detail: "height: unit vh", kind: "validator:profile" },
    { detail: "fetch https://x.y", kind: "network-blocked" },
  ],
  logs: [{ level: "error", text: "inline-1.js: ReferenceError: undefinedFn is not defined\n    at <eval> (inline-1.js:1:68)\n" }],
});

describe("preflightHtmlWidget", () => {
  it("passes a self-contained game and plain words", () => {
    expect(preflightHtmlWidget(GAME).findings).toEqual([]);
  });

  it("refuses what breaks a widget, each with a hint", () => {
    const html = `<input><img src="https://example.com/x.png"><script>fetch('x');alert(1);TelegramWidget.request('a');new Chart(c);location.href='https://t.me/x'</script>`;
    expect(preflightHtmlWidget(html).findings.map((finding) => finding.code)).toEqual([
      "link_telegram", "external_resource", "form_control", "network_call", "bot_request", "dialog_call", "external_library",
    ]);
    expect(preflightHtmlWidget("<script>let x = ;</script>").findings).toEqual([expect.objectContaining({ code: "script_syntax" })]);
    expect(preflightHtmlWidget("a\u0000b").findings).toEqual([expect.objectContaining({ code: "html_invalid" })]);
  });

  it("measures the size the way Telegram counts it", () => {
    const noise = Array.from({ length: 6_000 }, (_, index) => String.fromCharCode(0x4e00 + ((index * 7919) % 20_000))).join("");
    const result = preflightHtmlWidget(`<p>${noise}</p>`);
    expect(result.findings.map((finding) => finding.code)).toEqual(["compressed_too_large"]);
    expect(result.compressedBytes).toBeGreaterThan(3_800);
  });
});

describe("official check", () => {
  it("refuses script errors, blocked URLs, network calls and dropped elements; warns about stripped styling", () => {
    const verdict = readOfficialCheckReport(BROKEN_REPORT);
    expect(verdict.refusals.map((refusal) => refusal.code)).toEqual(["script_error", "element_dropped", "validator:url-blocked", "network-blocked"]);
    expect(verdict.warnings).toEqual(["validator:profile: font-family: \"Roboto\"", "validator:profile: height: unit vh"]);
    expect(readOfficialCheckReport(JSON.stringify({ diags: [], logs: [{ level: "log", text: "ok" }] }))).toEqual({ refusals: [], warnings: [] });
  });

  it("runs the harness as a child process and reads its report", async () => {
    const check = createOfficialCheck({ argv: () => [process.execPath, "-e", `process.stdout.write(${JSON.stringify(BROKEN_REPORT)})`], cwd: process.cwd() });
    expect((await check(GAME)).refusals).toHaveLength(4);
  });

  it("calls a crash or a broken report unavailable", async () => {
    const crash = createOfficialCheck({ argv: () => [process.execPath, "-e", "process.exit(3)"], cwd: process.cwd() });
    await expect(crash(GAME)).rejects.toMatchObject({ code: "AGENT_WIDGET_HTML_CHECK_UNAVAILABLE" });
    const garbage = createOfficialCheck({ argv: () => [process.execPath, "-e", "process.stdout.write('not json')"], cwd: process.cwd() });
    await expect(garbage(GAME)).rejects.toMatchObject({ code: "AGENT_WIDGET_HTML_CHECK_UNAVAILABLE" });
  });
});
