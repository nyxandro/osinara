/**
 * Personal memory export formatting.
 *
 * Exports:
 * - `MemoryExport`: versioned JSON export contract.
 * - `formatMemoryExportFiles`: produces UTF-8 JSON and readable Markdown documents.
 */
import type { MemoryItem } from "./memory-record.js";

export interface MemoryExport {
  exportedAt: string;
  records: readonly MemoryItem[];
  schemaVersion: 1;
}

function quoteMarkdown(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

export function formatMemoryExportFiles(memoryExport: MemoryExport): {
  json: string;
  markdown: string;
} {
  const markdownRecords = memoryExport.records.map((record, index) => [
    `## ${index + 1}. ${record.kind}`,
    "",
    `- ID: \`${record.id}\``,
    `- Область: \`${record.scope}\``,
    `- Создано: ${record.createdAt}`,
    `- Обновлено: ${record.updatedAt}`,
    `- Подтверждение: \`${record.confirmation}\``,
    `- Чувствительность: \`${record.sensitivity}\``,
    "",
    quoteMarkdown(record.content),
  ].join("\n"));
  return {
    json: `${JSON.stringify(memoryExport, null, 2)}\n`,
    markdown: [
      "# Экспорт личной памяти Osinara",
      "",
      `Дата экспорта: ${memoryExport.exportedAt}`,
      `Количество записей: ${memoryExport.records.length}`,
      "",
      ...markdownRecords,
      "",
    ].join("\n"),
  };
}
