/** Graphile 0.16.6 leaves a dead worker's job locked and never replaces its lost slot. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function patchPostgresWorkerRecovery(replace: (path: string, before: string, after: string) => Promise<void>) {
  const root = resolve("node_modules/graphile-worker");
  const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  if (pkg.version !== "0.16.6") throw new Error("AGENT_GRAPHILE_PATCH_VERSION_UNSUPPORTED: Expected graphile-worker 0.16.6");
  const main = `${root}/dist/main.js`;
  await replace(main, "    for (let i = 0; i < concurrency; i++) {\n        const worker = (0, worker_1.makeNewWorker)",
    "    const spawnWorker = () => {\n        const worker = (0, worker_1.makeNewWorker)");
  await replace(main, `            logger.error(\`Worker exited with error: \${error}\`, { error });`, `
            const unavailable = error && (['57P01','57P02','57P03','08006','ECONNRESET','ECONNREFUSED'].includes(error.code) ||
                ['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable'].includes(error.message));
            if (unavailable && continuous && workerPool._active && !workerPool._shuttingDown) {
                // This callback runs only after the worker promise has settled: its task is no longer executing.
                // This is the same native operation as WorkerUtils.forceUnlockWorkers, scoped to this dead worker.
                logger.error('AGENT_WORKFLOW_WORKER_RECOVERING', { workerId: worker.workerId });
                withPgClient.withRetries(client => client.query(
                    \`select \${compiledSharedOptions.escapedWorkerSchema}.force_unlock_workers($1::text[]);\`, [[worker.workerId]]))
                    .then(() => {
                        if (workerPool._active && !workerPool._shuttingDown) {
                            spawnWorker();
                            logger.info('AGENT_WORKFLOW_WORKER_RECOVERED', { workerId: worker.workerId });
                        }
                    })
                    .catch(recoveryError => {
                        logger.error('AGENT_WORKFLOW_WORKER_RECOVERY_FAILED', { workerId: worker.workerId, error: recoveryError });
                        void workerPool.gracefulShutdown('AGENT_WORKFLOW_WORKER_RECOVERY_EXHAUSTED')
                            .catch(shutdownError => logger.error('AGENT_WORKFLOW_POOL_SHUTDOWN_FAILED', { error: shutdownError }));
                    });
            } else {
                logger.error(\`Worker exited with error: \${error}\`, { error });
            }`);
  await replace(main, `    }
    // TODO: handle when a worker shuts down (spawn a new one)
    return workerPool;`, `    };
    for (let i = 0; i < concurrency; i++) spawnWorker();
    return workerPool;`);
  // Use the package's existing bounded retry policy for reconnecting bookkeeping, not a second job budget.
  await replace(`${root}/dist/lib.js`, "const RETRYABLE_ERROR_CODES = [", `const RETRYABLE_ERROR_CODES = [
    { code: "ECONNREFUSED", backoffMS: 1000 },
    { code: "ECONNRESET", backoffMS: 1000 },
    { code: "57P01", backoffMS: 1000 },
    { code: "57P02", backoffMS: 1000 },
    { code: "08006", backoffMS: 1000 },`);
  await replace(`${root}/dist/lib.js`,
    "const retryable = RETRYABLE_ERROR_CODES.find(({ code }) => code === e.code);",
    "const retryable = RETRYABLE_ERROR_CODES.find(({ code }) => code === e.code || (code === '08006' && ['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable'].includes(e.message)));");

  const streamer = resolve("node_modules/@workflow/world-postgres/dist/streamer.js");
  await replace(streamer, "    const client = new Client(pool.options);", `    const client = new Client(pool.options);
    let broken = false;
    const onError = error => {
        if (broken) return;
        broken = true;
        // Paged stream reads already poll PostgreSQL; LISTEN is only an optional wake-up hint.
        console.error(JSON.stringify({ code: 'AGENT_WORKFLOW_NOTIFY_CONNECTION_LOST', databaseCode: error.code }));
    };
    client.on('error', onError);`);
  await replace(streamer, "                await client.query(`UNLISTEN ${channel}`);", "                if (!broken) await client.query(`UNLISTEN ${channel}`);");
  await replace(streamer, "                await client.end();", "                await client.end();\n                client.removeListener('error', onError);");
}
