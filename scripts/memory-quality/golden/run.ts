/**
 * Operator entrypoint of the real-memory retrieval measurement.
 *
 *   pools <dir>  every conversation turn of the copy → <dir>/pools.jsonl and <dir>/skipped.jsonl
 *   score <dir>  <dir>/pools.jsonl with <dir>/labels.jsonl and <dir>/outside-pool.jsonl → JSON
 *
 * Run it through compose.memory-golden-eval.yaml, never against production: `pools` edits records
 * in the database it is given and refuses anything but a fresh, tuned `_eval` copy. The directory
 * holds real messages and memory text: it lives outside the repository, open to its owner only,
 * and is never committed.
 *
 * `labels.jsonl` holds one `{"turnId", "memoryRef", "relevant"}` line per pool record. A record is
 * relevant when a good answer to that message would use it or should take it into account; the
 * same topic about another person or object is not relevant. `outside-pool.jsonl` holds one
 * `{"turnId", "memoryRef"}` line per record a turn needed that no branch put into its pool; it
 * must exist, empty when there were none, so a forgotten file cannot pass for a perfect pool.
 */
import { appendFileSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AppError } from "../../../agent/lib/app-error.js";
import { closeDatabase } from "../../../agent/lib/database.js";
import { embedMemoryQueryChunks } from "../../../agent/lib/memory-embedding-client.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../../../agent/lib/memory-config.js";
import {
  memoryRetrievalSearchParameters,
  memoryRetrievalSearchStatement,
} from "../../../agent/lib/memory-retrieval-repository.js";
import {
  collectTurnCandidates,
  loadShowJournal,
  requireDisposableCopy,
  requireReviewedSearchStatement,
  rewindCopyTo,
  ungatedSearchParameters,
} from "./candidate-pool.js";
import { loadGoldenSet, PRIVATE_FILE_MODE, requirePrivateDirectory } from "./golden-files.js";
import { scoreGoldenSet, type NeededOutsidePool } from "./golden-score.js";
import { loadTurnQuestions } from "./turn-queries.js";

const [command, directory, ...extra] = process.argv.slice(2);
if ((command !== "pools" && command !== "score") || directory === undefined || extra.length > 0) {
  throw new AppError(
    "AGENT_MEMORY_GOLDEN_USAGE",
    "Укажите команду и папку данных замера: run.ts pools <папка> или run.ts score <папка>",
  );
}

async function pools(): Promise<void> {
  requirePrivateDirectory(directory!);
  const poolsPath = join(directory!, "pools.jsonl");
  // Written aside and renamed at the end: a run cut short leaves no file that passes for a full set.
  const partialPath = `${poolsPath}.partial`;
  // Labels are keyed to these pools: writing over them would leave the labels judging other sets.
  if (existsSync(poolsPath) || existsSync(partialPath)) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_POOLS_EXIST",
      `В ${directory} уже есть pools.jsonl или его незаконченная часть. Новый прогон пишите в новую папку данных`,
    );
  }
  // Both statement guards run before the copy is spent; the parameters' layout does not depend on
  // the question, so any question and rights show it.
  requireReviewedSearchStatement(memoryRetrievalSearchStatement());
  ungatedSearchParameters(memoryRetrievalSearchParameters({
    familyId: "layout-check", groupId: null, role: "owner", scopes: ["personal"], telegramActorId: "layout-check",
    telegramActorKind: "telegram_user", telegramUserId: "layout-check", userId: "layout-check",
  }, "проверка раскладки", [Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0)]));
  await requireDisposableCopy(readdirSync(resolve("migrations")).filter((name) => name.endsWith(".sql")).sort());
  // Read before the rewind: the journal names records it is about to hide.
  const journal = await loadShowJournal();
  const questions = await loadTurnQuestions();
  writeFileSync(partialPath, "", { mode: PRIVATE_FILE_MODE });
  writeFileSync(join(directory!, "skipped.jsonl"), questions
    .filter((one) => one.kind === "skipped").map((one) => `${JSON.stringify(one)}\n`).join(""), { mode: PRIVATE_FILE_MODE });
  // Newest first: see rewindCopyTo for why the order matters.
  for (const question of questions) {
    if (question.kind === "skipped") continue;
    await rewindCopyTo(question.startedAt);
    const embeddings = await embedMemoryQueryChunks(question.query);
    const turn = await collectTurnCandidates(
      question, embeddings, journal.get(`${question.sessionId}\u0000${question.turnId}`) ?? null,
    );
    appendFileSync(partialPath, `${JSON.stringify(turn)}\n`);
  }
  renameSync(partialPath, poolsPath);
}

function score(): void {
  const { labels, outside, turns } = loadGoldenSet(directory!);
  console.log(JSON.stringify(scoreGoldenSet(turns, labels, outside satisfies NeededOutsidePool), null, 2));
}

try {
  if (command === "pools") await pools();
  else score();
} finally {
  await closeDatabase();
}
