/**
 * Eve 0.22.5 local-workflow physical retention adapter.
 *
 * Export:
 * - `deleteLocalEveSession`: removes one run and all known local-world references.
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../app-error.js";

const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;

interface FileEntry {
  path: string;
  relativePath: string;
}

async function listFiles(root: string, relative = ""): Promise<FileEntry[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const childRelative = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, childRelative));
    } else if (entry.isFile()) {
      files.push({ path: join(root, childRelative), relativePath: childRelative });
    }
  }
  return files;
}

async function requireRun(root: string, runId: string): Promise<void> {
  try {
    await readFile(join(root, "runs", `${runId}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new AppError(
      "AGENT_EVE_SESSION_STORAGE_MISSING",
      `Не найдены данные удаляемой Eve-сессии ${runId}`,
    );
  }
}

async function streamIds(root: string, runId: string): Promise<string[]> {
  try {
    const raw = JSON.parse(
      await readFile(join(root, "streams", "runs", `${runId}.json`), "utf8"),
    ) as { streams?: unknown };
    if (!Array.isArray(raw.streams) || !raw.streams.every((value) => typeof value === "string")) {
      throw new Error("stream list is invalid");
    }
    return raw.streams;
  } catch (error) {
    throw new AppError(
      "AGENT_EVE_SESSION_STORAGE_LAYOUT_INVALID",
      `Структура потоков Eve-сессии ${runId} не соответствует версии 0.22.5: ${String(error)}`,
    );
  }
}

async function hookIds(root: string, runId: string): Promise<string[]> {
  const byRunRoot = join(root, "hooks", "by-run");
  const files = (await readdir(byRunRoot)).filter((name) => name.startsWith(`${runId}-`));
  const ids = new Set<string>();
  for (const name of files) {
    const raw = JSON.parse(await readFile(join(byRunRoot, name), "utf8")) as { hookId?: unknown };
    if (typeof raw.hookId !== "string" || !raw.hookId.startsWith("hook_")) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_LAYOUT_INVALID",
        `Индекс hook Eve-сессии ${runId} повреждён`,
      );
    }
    ids.add(raw.hookId);
  }
  return [...ids];
}

async function removePrefixedFiles(root: string, prefix: string): Promise<void> {
  const names = await readdir(root);
  await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) =>
    rm(join(root, name), { force: true, recursive: true })
  ));
}

export async function deleteLocalEveSession(root: string, runId: string): Promise<{
  hookCount: number;
  streamCount: number;
}> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) {
    throw new AppError("AGENT_EVE_SESSION_ID_INVALID", "Идентификатор удаляемой Eve-сессии некорректен");
  }
  await requireRun(root, runId);

  // Read secondary identifiers before deleting primary records.
  const streams = await streamIds(root, runId);
  const hooks = await hookIds(root, runId);
  const hookFiles = await listFiles(join(root, "hooks"));
  const hookReferences = [runId, ...hooks];
  const hookFilesToDelete: string[] = [];
  for (const file of hookFiles) {
    if (!file.relativePath.endsWith(".json")) continue;
    const content = await readFile(file.path, "utf8");
    if (hookReferences.some((reference) => content.includes(reference))) {
      hookFilesToDelete.push(file.path);
    }
  }

  // Each path is rooted under the fixed local-world directory; no model-controlled path is used.
  await Promise.all([
    rm(join(root, "runs", `${runId}.json`), { force: true }),
    rm(join(root, "streams", "runs", `${runId}.json`), { force: true }),
    removePrefixedFiles(join(root, "steps"), `${runId}-`),
    removePrefixedFiles(join(root, "events"), `${runId}-`),
    ...streams.map((streamId) =>
      rm(join(root, "streams", "chunks", streamId), { force: true, recursive: true })
    ),
    ...hookFilesToDelete.map((path) => rm(path, { force: true })),
  ]);

  // A stale hook could still resume deleted sensitive history, so verify references are gone.
  const remainingHookFiles = await listFiles(join(root, "hooks"));
  for (const file of remainingHookFiles) {
    if (!file.relativePath.endsWith(".json")) continue;
    const content = await readFile(file.path, "utf8");
    if (hookReferences.some((reference) => content.includes(reference))) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
        `Не удалось полностью удалить индексы Eve-сессии ${runId}`,
      );
    }
  }
  return { hookCount: hooks.length, streamCount: streams.length };
}
