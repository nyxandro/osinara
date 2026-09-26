/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error and records
 *   each call, with the failure code and log-only details, in one `AGENT_TOOL_CALL_METRICS` line.
 *
 * Key construct:
 * - The generic call contract is stated once in `agent/instructions.md`, so a descriptor carries
 *   only what is specific to its own tool.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { AppError } from "./app-error.js";
import { normalizeModelFacingError } from "./model-facing-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * The shared call contract lives once in the permanent core, not on every descriptor: repeating it
 * per tool cost about fifteen thousand characters of identical text in a single private-chat
 * request. A tool still states its own purpose, and a denied one still says it is unavailable.
 */
function completeDescription(description: string): string {
  return /недоступен/u.test(description)
    ? `${description} Не вызывай его и не пытайся обойти запрет другим инструментом.`
    : description;
}

export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    description: completeDescription(definition.description),
    async execute(input, ctx) {
      const started = performance.now();
      let outcome = "succeeded";
      let failure: { errorCode: string; errorDetails?: AppError["details"] } | undefined;
      try {
        return await definition.execute(input, ctx);
      } catch (error) {
        outcome = "failed";
        const normalized = normalizeModelFacingError(error, { toolName });
        // The single structured record of a failed call: Eve skips its stack for expected refusals.
        failure = { errorCode: normalized.contract.code };
        if (error instanceof AppError && error.details !== undefined) failure.errorDetails = error.details;
        throw normalized;
      } finally {
        console.info(JSON.stringify({ code: "AGENT_TOOL_CALL_METRICS", toolName, outcome,
          sessionId: ctx?.session?.id ?? null, turnId: ctx?.session?.turn?.id ?? null,
          callId: ctx?.callId ?? null, durationMs: Math.round(performance.now() - started), ...failure }));
      }
    },
  });
}

export function wrapModelFacingToolMap<T extends Readonly<Record<string, AnyToolDefinition>>>(
  surface: T,
): T {
  return Object.fromEntries(
    Object.entries(surface).map(([name, definition]) => [
      name,
      wrapModelFacingTool(name, definition),
    ]),
  ) as T;
}
