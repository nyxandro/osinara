/**
 * Runs Telegram's official widget check over every reference widget the A2UI builder produces (#468, F4).
 *
 * The builder writes the HTML of A2UI widgets, so the official check proves the builder rather than each
 * widget: run this after changing anything in `agent/lib/widgets/a2ui/`. It takes widget-sandbox at the
 * release the image pins, into a temporary folder (the repository has no licence, so none of its code is
 * kept here), checks each built example and removes the folder. Fails when any example has a script
 * error, a dropped element, a blocked URL or network call, or exceeds the size margin.
 *
 *   npx tsx scripts/widgets/check-widgets-with-official-sandbox.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderWidget } from "../../agent/lib/widgets/a2ui/render.js";
import { validateCreateSurface } from "../../agent/lib/widgets/a2ui/validate-surface.js";
import { WIDGET_EXAMPLES } from "../../agent/lib/widgets/a2ui/widget-examples.js";
import { readOfficialCheckReport } from "../../agent/lib/widgets/html/official-check.js";
import { WIDGET_COMPRESSED_MAX_BYTES } from "../../agent/lib/widgets/widget-config.js";

// The same release as the Dockerfile's `widget-check` stage.
const TAG = "v0.6.1";
const COMMIT = "3acba1b62093c83815d38603d26f48c4f26a94c2";
// The same manifest and lockfile the image installs the checker with.
const MANIFEST = "infra/widget-check";

const work = mkdtempSync(join(tmpdir(), "osinara-widget-check-"));
let failed = false;
try {
  const source = join(work, "source");
  const checker = join(work, "checker");
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", TAG, "https://github.com/TelegramMessenger/widget-sandbox.git", source]);
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== COMMIT) throw new Error(`widget-sandbox ${TAG} is ${head}, expected ${COMMIT}`);
  execFileSync("mkdir", ["-p", checker]);
  execFileSync("cp", ["-r", join(source, "packages/core/src"), join(source, "packages/core/scripts"), join(source, "packages/core/profile.json"), checker]);
  execFileSync("cp", ["-r", join(source, "packages/quickjs-wasm"), join(checker, "quickjs-wasm")]);
  execFileSync("cp", [join(MANIFEST, "package.json"), join(MANIFEST, "package-lock.json"), checker]);
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: checker });
  for (const example of WIDGET_EXAMPLES) {
    const validated = validateCreateSurface(example.message);
    if (!validated.ok) throw new Error(`${example.name}: ${JSON.stringify(validated.errors)}`);
    const rendered = renderWidget(validated.surface);
    if (!rendered.ok) throw new Error(`${example.name}: ${JSON.stringify(rendered.errors)}`);
    const file = join(work, `${example.name}.html`);
    writeFileSync(file, rendered.widget.html);
    const report = execFileSync(process.execPath, ["--import", "tsx", "scripts/sandbox-node.ts", file, "--json"], { cwd: checker, encoding: "utf8" });
    const verdict = readOfficialCheckReport(report);
    const fits = rendered.widget.compressedBytes <= WIDGET_COMPRESSED_MAX_BYTES;
    const ok = fits && verdict.refusals.length === 0 && verdict.warnings.length === 0;
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${example.name}: ${rendered.widget.compressedBytes} B compressed${verdict.refusals.length + verdict.warnings.length > 0 ? `, ${JSON.stringify({ refusals: verdict.refusals, warnings: verdict.warnings })}` : ""}`);
  }
} finally {
  rmSync(work, { force: true, recursive: true });
}
if (failed) process.exitCode = 1;
