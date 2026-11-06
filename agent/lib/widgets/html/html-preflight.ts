/**
 * The quick check of a widget the model wrote as its own HTML (a game or an animation, F6 B of #468).
 *
 * Exports:
 * - `HtmlFinding`: one problem with how to fix it.
 * - `preflightHtmlWidget`: the sizes and every finding, before Telegram's official check runs.
 *
 * Key constructs:
 * - It refuses only what breaks the widget or its sending: Telegram's size, broken text, links into
 *   Telegram, remote resources, form controls, network calls, requests to the bot (this widget has no
 *   connection to it), dialogs, chart libraries Telegram does not bundle, and scripts that do not even
 *   parse. What Telegram merely strips (a font, `vh`) is left to the official check's warnings.
 * - It reads the text without parsing HTML: it is advice to the model before the real check, while the
 *   isolation of the widget is Telegram's own sandbox.
 * - A script is compiled without running (`vm.Script`), so a syntax error is found here and nothing of
 *   the model's code runs in this process.
 */
import { Script } from "node:vm";
import { deflateSync } from "node:zlib";

import { WIDGET_COMPRESSED_MAX_BYTES, WIDGET_HTML_MAX_BYTES } from "../widget-config.js";

export interface HtmlFinding {
  readonly code: string;
  readonly hint: string;
}

const RULES: readonly { readonly code: string; readonly pattern: RegExp; readonly hint: string }[] = [
  { code: "link_telegram", hint: "links into Telegram are not allowed in a widget; use an https web page with openLink or drop it", pattern: /t\.me\/|telegram\.(me|dog)\/|tg:\/\/|openTelegramLink/iu },
  { code: "external_resource", hint: "a widget loads nothing from the network: inline images as data:, no external scripts, styles or fonts", pattern: /<(img|script|link|iframe|object|embed|audio|video|source)\b[^>]*\s(src|href|data)\s*=\s*["']?(?!data:|#)[a-z]+:|url\(\s*["']?(?!data:|#)[a-z]+:|@import/iu },
  { code: "form_control", hint: "a widget has no keyboard and no form controls (input, select, textarea, form, label): use buttons", pattern: /<(input|select|textarea|form|option|label|datalist)\b/iu },
  { code: "network_call", hint: "a widget has no network: fetch, XMLHttpRequest, WebSocket and the like always fail; put the data into the HTML", pattern: /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/u },
  { code: "bot_request", hint: "this widget is not connected to the bot: TelegramWidget.request, sendMessage and wallet do not work; describe an A2UI widget if presses must reach the agent", pattern: /TelegramWidget\s*\.\s*(request|sendMessage|wallet)|\bTW\s*\.\s*(request|wallet)/u },
  { code: "dialog_call", hint: "alert, confirm and prompt do not exist in a widget: show the message in the page", pattern: /\b(alert|confirm|prompt)\s*\(/u },
  { code: "external_library", hint: "no library is bundled: draw charts with canvas or SVG yourself", pattern: /\bnew\s+Chart\s*\(|\bd3\s*\./u },
];

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;

function scriptFindings(html: string): HtmlFinding[] {
  const findings: HtmlFinding[] = [];
  let position = 0;
  for (const match of html.matchAll(SCRIPT)) {
    position += 1;
    if (/\bsrc\s*=/iu.test(match[1] ?? "")) continue; // reported as an external resource
    try {
      new Script(match[2] ?? "", { filename: `script-${position}.js` });
    } catch (error) {
      findings.push({ code: "script_syntax", hint: `script ${position} does not parse: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return findings;
}

export function preflightHtmlWidget(html: string): { compressedBytes: number; findings: HtmlFinding[]; htmlBytes: number } {
  const findings: HtmlFinding[] = [];
  if (/\0/u.test(html) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(html)) {
    findings.push({ code: "html_invalid", hint: "the HTML has a NUL or a broken character; send plain UTF-8 text" });
  }
  const buffer = Buffer.from(html, "utf8");
  const compressedBytes = deflateSync(buffer, { level: 9 }).length;
  if (buffer.length > WIDGET_HTML_MAX_BYTES) {
    findings.push({ code: "html_too_large", hint: `${buffer.length} bytes of HTML, Telegram takes ${WIDGET_HTML_MAX_BYTES}: shorten it` });
  }
  if (compressedBytes > WIDGET_COMPRESSED_MAX_BYTES) {
    findings.push({ code: "compressed_too_large", hint: `${compressedBytes} bytes compressed, at most ${WIDGET_COMPRESSED_MAX_BYTES}: remove comments, repeated styles, long texts and data: images` });
  }
  for (const rule of RULES) if (rule.pattern.test(html)) findings.push({ code: rule.code, hint: rule.hint });
  findings.push(...scriptFindings(html));
  return { compressedBytes, findings, htmlBytes: buffer.length };
}
