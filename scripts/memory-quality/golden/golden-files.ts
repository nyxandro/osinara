/**
 * The files of one golden-set run directory, read and checked.
 *
 * Exports:
 * - `PRIVATE_FILE_MODE` / `requirePrivateDirectory`: the directory holds real messages and memory
 *   text, so it must be open to its owner only, and so must every file written into it.
 * - `readJsonLines` / `parseLines`: JSON Lines with coded errors that name the line.
 * - `GoldenSetTurn` / `loadGoldenSet`: pools, labels and needed-outside-pool notes of one run.
 *
 * The file formats are described in the header of `run.ts`.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { AppError } from "../../../agent/lib/app-error.js";
import type { GoldenLabels, GoldenTurn } from "./golden-score.js";

export const PRIVATE_FILE_MODE = 0o600;

export function requirePrivateDirectory(directory: string): void {
  let mode: number;
  try {
    mode = statSync(directory).mode & 0o777;
  } catch (error) {
    throw new AppError("AGENT_MEMORY_GOLDEN_INPUT_UNREADABLE", `Папка данных замера ${directory} недоступна. Создайте её с правами 0700`, { cause: error });
  }
  if (mode !== 0o700) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_DATA_DIR_EXPOSED",
      `Папка данных замера ${directory} открыта не только владельцу (права ${mode.toString(8)}). В ней живые сообщения: выставьте права 0700`,
    );
  }
}

export function readJsonLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new AppError("AGENT_MEMORY_GOLDEN_INPUT_UNREADABLE", `Не удалось прочитать ${path}. Проверьте папку данных замера`, { cause: error });
  }
  const body = text.replace(/\n+$/u, "");
  return body === "" ? [] : body.split("\n").map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new AppError("AGENT_MEMORY_GOLDEN_INPUT_INVALID", `Строка ${index + 1} файла ${path} не является JSON`, { cause: error });
    }
  });
}

export function parseLines<T>(path: string, schema: z.ZodType<T>): T[] {
  return readJsonLines(path).map((raw, index) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_INPUT_INVALID",
      `Строка ${index + 1} файла ${path} не по формату`,
      { cause: parsed.error },
    );
  });
}

const poolsLine = z.object({
  gated: z.array(z.string()),
  message: z.string(),
  offered: z.array(z.object({ memoryRef: z.string().min(1), position: z.number().int().positive() })),
  pool: z.array(z.object({ branches: z.array(z.string()), content: z.string(), memoryRef: z.string().min(1) })),
  production: z.object({ shown: z.array(z.string()), used: z.array(z.string()) }).nullable(),
  query: z.string(),
  startedAt: z.string().datetime(),
  turnId: z.string().min(1),
});
const labelLine = z.object({ memoryRef: z.string().min(1), relevant: z.boolean(), turnId: z.string().min(1) });
const outsideLine = z.object({ memoryRef: z.string().min(1), turnId: z.string().min(1) });

export type GoldenSetTurn = Omit<GoldenTurn, "pool"> & {
  pool: readonly { branches: readonly string[]; content: string; memoryRef: string }[];
  startedAt: string;
};

export function loadGoldenSet(directory: string): {
  labels: GoldenLabels[];
  outside: Map<string, Set<string>>;
  turns: GoldenSetTurn[];
} {
  const turns = parseLines(join(directory, "pools.jsonl"), poolsLine);
  const byTurn = new Map<string, Map<string, boolean>>();
  for (const label of parseLines(join(directory, "labels.jsonl"), labelLine)) {
    const turn = byTurn.get(label.turnId) ?? new Map<string, boolean>();
    if (turn.has(label.memoryRef)) {
      throw new AppError(
        "AGENT_MEMORY_GOLDEN_LABEL_DUPLICATE",
        `Запись ${label.memoryRef} хода ${label.turnId} размечена в labels.jsonl дважды. Оставьте одну метку`,
      );
    }
    turn.set(label.memoryRef, label.relevant);
    byTurn.set(label.turnId, turn);
  }
  const outside = new Map<string, Set<string>>();
  for (const line of parseLines(join(directory, "outside-pool.jsonl"), outsideLine)) {
    outside.set(line.turnId, (outside.get(line.turnId) ?? new Set<string>()).add(line.memoryRef));
  }
  return { labels: [...byTurn].map(([turnId, relevant]) => ({ relevant, turnId })), outside, turns };
}
