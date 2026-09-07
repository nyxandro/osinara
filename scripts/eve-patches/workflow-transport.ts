/** Keep queue transport and live execution ownership separate in the installed Postgres World. */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

export async function patchWorkflowTransport(replace: (path: string, before: string, after: string, count?: number) => Promise<void>) {
  const root = resolve("node_modules/@workflow/world-postgres");
  const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  if (pkg.version !== "5.0.0-beta.35") throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  const runtime = stripTypeScriptTypes(await readFile("scripts/runtime/workflow-transport.ts", "utf8"));
  await writeFile(`${root}/dist/osinara-workflow-transport.js`, runtime, "utf8");
  const queue = `${root}/dist/queue.js`;
  await replace(queue,
    "import { connect } from 'node:net';",
    "import { connect } from 'node:net';\nimport { createWorkflowHttpClient, createWorkflowExecutionFence } from './osinara-workflow-transport.js';");
  await replace(queue,
    "    const createQueueHandler = localWorld.createQueueHandler;",
    "    const httpClient = createWorkflowHttpClient();\n    const fence = createWorkflowExecutionFence(() => closing);\n    const createQueueHandler = (prefix, handler) => localWorld.createQueueHandler(prefix, fence(handler));");
  await replace(queue,
    "const response = await fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {",
    "const response = await httpClient.fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {");
  await replace(queue,
    "            await localWorld.close?.();",
    "            await httpClient.close();\n            await localWorld.close?.();");
  // Workflow executes steps inline in a workflow HTTP request. Serializing all replays behind
  // that request prevents cancellation hooks from reaching the still-running step.
  await replace(queue, "resolveQueueNamespace, WorkflowInvokePayloadSchema, }", "resolveQueueNamespace, }");
  await replace(queue, "    const inflightWorkflowRuns = new Map();", "    // Whole-run HTTP serialization would block native cancellation of inline steps.");
  await replace(queue, `            const workflowInvoke = WorkflowInvokePayloadSchema.safeParse(body);
            const workflowRunSerializationKey = workflowInvoke.success && !workflowInvoke.data.stepId
                ? \`workflow:\${workflowInvoke.data.runId}\`
                : undefined;`, "            // Independent replays retain Workflow's native atomic step claims.");
  await replace(queue, `                if (workflowRunSerializationKey) {
                    // Preserve step fan-out while preventing two workflow replays from
                    // mutating the same run's event log at the same time.
                    const previous = inflightWorkflowRuns.get(workflowRunSerializationKey);
                    const execution = (previous ?? Promise.resolve())
                        .catch(() => { })
                        .then(() => executeTask())
                        .finally(() => {
                        if (inflightWorkflowRuns.get(workflowRunSerializationKey) ===
                            execution) {
                            inflightWorkflowRuns.delete(workflowRunSerializationKey);
                        }
                    });
                    inflightWorkflowRuns.set(workflowRunSerializationKey, execution);
                    await execution;
                    return;
                }`, "                // Do not queue a cancellation replay behind its own inline step.");
}
