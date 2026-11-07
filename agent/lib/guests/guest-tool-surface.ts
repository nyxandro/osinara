/**
 * A guest's tools (#471): a family member's private-chat set, less what the owner turned off for this guest.
 *
 * Exports:
 * - `guestToolCatalog`: every tool name a guest's chat can carry, live or in a scheduled run; the owner turns
 *   tools off by these names.
 * - `guestToolSurface`: the surface cut by the policy, each tool re-checking the policy when it runs, so a tool
 *   the owner turned off while a confirmation button waited does not run after the press.
 *
 * The surface is resolved before every model call, so a change works from the guest's next step.
 */
import type { ToolDefinition } from "../../runtime/tool.js";
import { ModelFacingError, normalizeModelFacingError } from "../model-facing-error.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";
import type { SessionGuest } from "./guest-policy.js";
import { loadGuestAccessPolicy } from "./guest-repository.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export function guestToolCatalog(): readonly string[] {
  return [...new Set([
    ...Object.keys(buildModeToolSurface({ environment: "private", owner: false })),
    ...Object.keys(buildModeToolSurface({ environment: "private", owner: false, scheduledRun: true })),
  ])].sort();
}

function guestRefusal(code: "AGENT_GUEST_ACCESS_REVOKED" | "AGENT_GUEST_TOOL_DISABLED"): ModelFacingError {
  const revoked = code === "AGENT_GUEST_ACCESS_REVOKED";
  return new ModelFacingError({
    category: "authorization",
    code,
    correction: revoked
      ? "Не вызывайте инструменты и завершите ход."
      : "Не вызывайте этот инструмент и не обходите запрет другим; скажите человеку, что владелец агента выключил его для гостя.",
    reason: revoked ? "Владелец закрыл вам доступ к агенту" : "Владелец выключил вам этот инструмент",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

async function requireGuestTool(familyId: string, toolName: string): Promise<void> {
  const policy = await loadGuestAccessPolicy(familyId);
  if (policy === null || !policy.active) throw guestRefusal("AGENT_GUEST_ACCESS_REVOKED");
  if (policy.disabledTools.has(toolName)) throw guestRefusal("AGENT_GUEST_TOOL_DISABLED");
}

/**
 * Runs outside the surface's model-facing wrapper, so it reports its own refusals: an expected refusal is not
 * logged by the runtime, and an unreadable policy must reach the model as a coded refusal, not a database error.
 */
function gateGuestTool(toolName: string, definition: AnyToolDefinition, familyId: string): AnyToolDefinition {
  return {
    ...definition,
    async execute(input: unknown, ctx: Parameters<AnyToolDefinition["execute"]>[1]) {
      try {
        await requireGuestTool(familyId, toolName);
      } catch (error) {
        if (error instanceof ModelFacingError) {
          // The call's one metrics record, as the model-facing wrapper writes it for any refused call.
          console.info(JSON.stringify({ code: "AGENT_TOOL_CALL_METRICS", toolName, outcome: "failed",
            sessionId: ctx?.session?.id ?? null, turnId: ctx?.session?.turn?.id ?? null,
            callId: ctx?.callId ?? null, durationMs: 0, errorCode: error.code }));
          throw error;
        }
        throw normalizeModelFacingError(error, { toolName });
      }
      return await definition.execute(input, ctx);
    },
  };
}

export function guestToolSurface(surface: ToolMap, guest: SessionGuest): ToolMap {
  // A removed guest has no new turns; a run already under way loses every tool at its next step.
  if (!guest.policy.active) return {};
  return Object.fromEntries(Object.entries(surface)
    .filter(([name]) => !guest.policy.disabledTools.has(name))
    .map(([name, definition]) => [name, gateGuestTool(name, definition, guest.familyId)]));
}
