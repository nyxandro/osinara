/** Use AI SDK's existing output-aware timers; do not implement a parallel model watchdog. */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

export async function patchModelInactivity(replace: (path: string, before: string, after: string) => Promise<void>) {
  const ai = resolve("node_modules/ai");
  const pkg = JSON.parse(await readFile(`${ai}/package.json`, "utf8"));
  if (pkg.version !== "7.0.60") throw new Error("AGENT_AI_SDK_PATCH_VERSION_UNSUPPORTED: Expected AI SDK 7.0.60");
  const root = resolve("node_modules/eve/dist/src/harness");
  await writeFile(`${root}/osinara-model-inactivity.js`, stripTypeScriptTypes(await readFile("scripts/eve-runtime/model-inactivity.ts", "utf8")));
  await replace(`${root}/tool-loop.js`, 'import{ToolLoopAgent,isStepCount}from"ai";',
    'import{ToolLoopAgent,isStepCount}from"ai";import{MODEL_INACTIVITY_TIMEOUT}from"./osinara-model-inactivity.js";');
  await replace(`${root}/tool-loop.js`, "new ToolLoopAgent({headers:_e,", "new ToolLoopAgent({timeout:MODEL_INACTIVITY_TIMEOUT,headers:_e,");
  // In 7.0.60 the first-output timer starts after doStream's headers, and the gap timer
  // outlives provider output while executeToolsFromStream drains local tools. Scope the
  // existing SDK timers to the provider call, not to preparation or tool execution.
  await replace(`${ai}/dist/index.js`, `          const {
            stream: languageModelStream,
            request,
            response
          } = await runInStepTracingChannelContext(`, `          let osinaraModelOutputEnded = false;
          startFirstChunkTimeout();
          const {
            stream: languageModelStream,
            request,
            response
          } = await runInStepTracingChannelContext(`);
  await replace(`${ai}/dist/index.js`, `          startFirstChunkTimeout();
          const streamAfterToolCallbackInvocation`, `          // The provider's header wait is already covered by the first-output timer.
          const streamAfterToolCallbackInvocation`);
  await replace(`${ai}/dist/index.js`, `                  onLanguageModelCallEnd: filterNullable2(
                    onLanguageModelCallEnd,`, `                  onLanguageModelCallEnd: filterNullable2(
                    () => { osinaraModelOutputEnded = true; clearFirstChunkTimeout(); clearChunkTimeout(); },
                    onLanguageModelCallEnd,`);
  await replace(`${ai}/dist/index.js`, "                    resetChunkTimeout();", "                    if (!osinaraModelOutputEnded) resetChunkTimeout();");
}
