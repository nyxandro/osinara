/**
 * Common model-facing execution boundary for application tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error and records
 *   each call, with the failure code and log-only details, in one `AGENT_TOOL_CALL_METRICS` line.
 *
 * Key construct:
 * - The generic call contract is stated once in `agent/instructions.md`, so a descriptor carries
 *   only what is specific to its own tool.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 * - `gateDisconnectedGroup`: only the disconnected-group check, for a runtime built-in.
 * - A turn of a disconnected group gets no tool at all (#465): a task that was running when the owner
 *   disconnected the group stops at its next call, whatever the tool, before it touches anything. A
 *   background memory review is the one exception: it only finishes the history already recorded.
 */
import { defineTool, type ToolDefinition } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import { isGroupIdDisconnected } from "./group-connection/group-connection-repository.js";
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

async function inDisconnectedGroup(ctx: unknown): Promise<boolean> {
  const attributes = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } } | undefined)
    ?.session?.auth?.current?.attributes;
  const groupId = attributes?.groupId;
  // A background memory review taken before the disconnection finishes on history already recorded and
  // writes nothing to the chat; new reviews are not taken while the group is disconnected.
  if (typeof groupId !== "string" || attributes?.memoryReviewMode === "background") return false;
  return await isGroupIdDisconnected(groupId);
}

function disconnectedGroupRefusal(): AppError {
  return new AppError(
    "AGENT_GROUP_DISCONNECTED",
    "Владелец отключил эту группу: до подключения здесь ничего не делается. Не вызывайте инструменты и завершите ход",
    { isExpectedRefusal: true },
  );
}

async function requireConnectedGroup(ctx: unknown): Promise<void> {
  if (await inDisconnectedGroup(ctx)) throw disconnectedGroupRefusal();
}

export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  const approval = definition.approval;
  return defineTool({
    ...definition,
    // A tool with a confirmation is refused before its card: a card refused later would fail the turn and
    // tell the owner about an error in a group they disconnected themselves.
    ...(approval === undefined ? {} : {
      async approval(ctx: Parameters<NonNullable<AnyToolDefinition["approval"]>>[0]) {
        if (await inDisconnectedGroup(ctx)) return { reason: disconnectedGroupRefusal().message, type: "denied" as const };
        return await approval(ctx);
      },
    }),
    description: completeDescription(definition.description),
    async execute(input, ctx) {
      const started = performance.now();
      let outcome = "succeeded";
      let failure: { errorCode: string; errorDetails?: AppError["details"] } | undefined;
      try {
        await requireConnectedGroup(ctx);
        return await definition.execute(input, ctx);
      } catch (error) {
        outcome = "failed";
        const normalized = normalizeModelFacingError(error, { toolName });
        // The single structured record of a failed call: the runtime does not log expected refusals
        // again (`runtime/turn/tool-calls.ts`).
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

/**
 * Only the disconnected-group check, for a runtime built-in whose own errors are already written for
 * the model (the delegation tool): a task cut off by the disconnection must not start a paid sub-task.
 */
export function gateDisconnectedGroup(definition: AnyToolDefinition): AnyToolDefinition {
  return {
    ...definition,
    async execute(input: unknown, ctx: Parameters<AnyToolDefinition["execute"]>[1]) {
      await requireConnectedGroup(ctx);
      return await definition.execute(input, ctx);
    },
  };
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
