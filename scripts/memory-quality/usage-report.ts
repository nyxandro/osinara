/**
 * Operator report: how much of what memory offered the answers rested on.
 *
 * Reads one export of memory log lines, JSON per line, and prints the summary from
 * `usage-summary.ts` as JSON. The lines live in the log store on the monitoring hub; export a
 * period with the fields the report reads, for example the last seven days:
 *
 *   ssh remote-vibe-station "curl -s 127.0.0.1:9428/select/logsql/query --data-urlencode \
 *     'query=project:\"osinara-production\" code:in(AGENT_MEMORY_RETRIEVAL_METRICS, \
 *     AGENT_MEMORY_SEARCH_METRICS, AGENT_MEMORY_USAGE_DIRECTIVE) _time:7d | fields _time, code, \
 *     sessionId, turnId, outcome, usageTracked, memoryEvidence, memorySerializedCharacters, \
 *     profileMemoryRefs, memoryRefs, window.from, window.to, declared, finishReason, usedRefs, \
 *     rejectedRefs'" > lines.jsonl
 *   npm run memory:usage-report -- lines.jsonl
 *
 * Lines carry opaque refs and numbers only, never memory text, so the export holds nothing a
 * person wrote.
 */
import { readFileSync } from "node:fs";

import { AppError } from "../../agent/lib/app-error.js";
import { summarizeMemoryUsage } from "./usage-summary.js";

const [path, ...extra] = process.argv.slice(2);
if (path === undefined || extra.length > 0) {
  throw new AppError(
    "AGENT_MEMORY_USAGE_REPORT_INPUT_MISSING",
    "Укажите один файл выгрузки логов памяти: npm run memory:usage-report -- lines.jsonl",
  );
}

let text: string;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  throw new AppError(
    "AGENT_MEMORY_USAGE_REPORT_INPUT_UNREADABLE",
    `Не удалось прочитать файл ${path}. Проверьте путь к выгрузке логов памяти`,
    { cause: error },
  );
}
// Only the trailing newline the export ends with is dropped, so a line number in an error is the
// line number in the file. An empty export is a period with no lines, not a malformed one.
const body = text.replace(/\n+$/u, "");
const lines = body === "" ? [] : body.split("\n");
const parsed = lines.map((line, index) => {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new AppError(
      "AGENT_MEMORY_USAGE_REPORT_LINE_INVALID",
      `Строка ${index + 1} файла ${path} не является JSON. Выгрузите логи заново командой из шапки скрипта`,
      { cause: error },
    );
  }
});

console.log(JSON.stringify(summarizeMemoryUsage(parsed), null, 2));
