/**
 * Memory tools of an external group, by the group's rights.
 *
 * Exports:
 * - `EXTERNAL_MEMORY_ACTION_RIGHTS`, `EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS`: the stored right each
 *   action needs.
 * - `FOLDED_MEMORY_RIGHTS`: stored rights that give an action of a memory tool, not a tool of their own.
 * - `externalMemoryTools`: `manage_memory` and `manage_memory_thread` with only the granted actions.
 * - `authorizeExternalGroupRight`: the live check of one right for the group of the current turn.
 *
 * Key constructs:
 * - Rights keep the names under which owners granted them and groups and automations store them
 *   (`list_memories`, `read_memory_thread`, …): since #457 they name an action, not a tool, so no
 *   stored policy changes and no group gains or loses anything.
 * - Each call re-checks its own right against the live policy before the tool runs.
 */
import type { ToolContext, ToolDefinition } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import manageMemory, { manageMemoryPresentation, MANAGE_MEMORY_ACTIONS, type ManageMemoryAction } from "../tools/manage_memory.js";
import manageMemoryThread, {
  manageMemoryThreadPresentation,
  MEMORY_THREAD_ACTIONS,
  type MemoryThreadAction,
} from "../tools/manage_memory_thread.js";
import { actionView } from "./action-view.js";
import { authorizeCurrentExternalGroupCapability } from "./external-group-live-policy.js";
import { resolveExternalGroupPolicyIdentity } from "./external-group-policy.js";
import type { ExternalGroupToolName } from "./group-tool-catalog.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const GROUP_ONLY: readonly [string] = ["group"];
const AREA = "of the current external group";

export const EXTERNAL_MEMORY_ACTION_RIGHTS: Readonly<Record<ManageMemoryAction, ExternalGroupToolName>> = {
  list: "list_memories",
  edit: "manage_memory.edit",
  delete: "manage_memory.delete",
  undo: "manage_memory.undo",
};

export const EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS: Readonly<Record<MemoryThreadAction, ExternalGroupToolName>> = {
  list: "list_memory_threads",
  search: "search_memory_threads",
  read: "read_memory_thread",
  complete: "manage_memory_thread.complete",
  reactivate: "manage_memory_thread.reactivate",
};

export const FOLDED_MEMORY_RIGHTS: ReadonlySet<ExternalGroupToolName> = new Set([
  ...Object.values(EXTERNAL_MEMORY_ACTION_RIGHTS),
  ...Object.values(EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS),
]);

/**
 * Committing this final live check is the operation's authorization linearization point. The check
 * releases its database connection before the tool's repositories run, so concurrent tools cannot
 * exhaust the pool by each holding an outer connection while waiting for an inner one.
 */
export async function authorizeExternalGroupRight(ctx: ToolContext, right: ExternalGroupToolName): Promise<void> {
  const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
  if (!identity) {
    throw new AppError(
      "AGENT_GROUP_TOOL_FORBIDDEN",
      "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
    );
  }
  await authorizeCurrentExternalGroupCapability(identity, right);
}

export function externalMemoryTools(allowed: ReadonlySet<ExternalGroupToolName>): Record<string, AnyToolDefinition> {
  const tools: Record<string, AnyToolDefinition> = {};
  const memoryActions = MANAGE_MEMORY_ACTIONS.filter((action) => allowed.has(EXTERNAL_MEMORY_ACTION_RIGHTS[action]));
  if (memoryActions.length > 0) {
    tools.manage_memory = actionView({
      actions: memoryActions,
      authorize: async (ctx, action) => await authorizeExternalGroupRight(ctx, EXTERNAL_MEMORY_ACTION_RIGHTS[action]),
      definition: manageMemory as unknown as AnyToolDefinition,
      // A group's list never showed earlier versions of its records (#457 keeps it so).
      presentation: manageMemoryPresentation(memoryActions, { area: AREA, history: false, listScopes: GROUP_ONLY }),
      toolName: "manage_memory",
    });
  }
  const threadActions = MEMORY_THREAD_ACTIONS.filter((action) => allowed.has(EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS[action]));
  if (threadActions.length > 0) {
    tools.manage_memory_thread = actionView({
      actions: threadActions,
      authorize: async (ctx, action) => await authorizeExternalGroupRight(ctx, EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS[action]),
      definition: manageMemoryThread as unknown as AnyToolDefinition,
      presentation: manageMemoryThreadPresentation(threadActions, { area: AREA, listScopes: GROUP_ONLY }),
      toolName: "manage_memory_thread",
    });
  }
  return tools;
}
