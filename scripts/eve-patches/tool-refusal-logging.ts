/**
 * Eve prints every tool exception with a multi-line stack. For an expected coded refusal the tool
 * boundary already wrote one `AGENT_TOOL_CALL_METRICS` line with the code, and the stack only
 * trips the unstructured-problem alert (#289, #302). Only refusals caused by the call itself, or
 * explicitly marked by the thrower, carry `isExpectedRefusal`; every other failure keeps Eve's log.
 */
import { resolve } from "node:path";

type ReplaceExact = (path: string, before: string, after: string) => Promise<void>;

export async function patchToolRefusalLogging(replace: ReplaceExact) {
  await replace(
    resolve("node_modules/eve/dist/src/harness/tool-loop.js"),
    "function logToolExecutionError(e){e.toolOutput.type===`tool-error`&&logError(",
    "function logToolExecutionError(e){e.toolOutput.type===`tool-error`&&!(e.toolOutput.error?.name===`ModelFacingError`&&e.toolOutput.error.isExpectedRefusal===!0)&&logError(",
  );
}
