/**
 * Least-privilege tool surface for silent memory review.
 *
 * Exports:
 * - `buildMemoryReviewToolSurface`: memory reads and source-backed normal-sensitivity writes only.
 *
 * Listing records and reading threads are actions of the memory tools since #457: the review gets
 * them as reading views, each action checked against its own right in an external group.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import { wrapModelFacingToolMap } from "../model-facing-tool.js";
import manageMemory, { manageMemoryPresentation } from "../tools/manage_memory.js";
import manageMemoryThread, {
  manageMemoryThreadPresentation,
  MEMORY_THREAD_READING_ACTIONS,
} from "../tools/manage_memory_thread.js";
import remember from "../tools/remember.js";
import searchMemories from "../tools/search_memories.js";
import { createReviewRememberInputSchema } from "../remember-contract.js";
import type { MemoryScope } from "../memory-context.js";
import { actionView } from "../tool-policy/action-view.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS } from "../tool-policy/external-group-memory-tools.js";
import { resolveExternalGroupPolicyIdentity } from "../tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";

type AnyTool = ToolDefinition<any, any>;

/**
 * The run is authorized for exactly one scope, so the schema admits only that one and fills it: an
 * external group already gets its remember this way, and a model cannot name a scope it cannot
 * express. Its other constants are filled the same way, and its source message is required.
 */
function reviewRememberSchema(scope: MemoryScope) {
  // Review turns get no profile views: a verified_ref there was refused on every call (#289).
  return createReviewRememberInputSchema(scope);
}


function reviewRemember(scope: MemoryScope): AnyTool {
  const definition = remember as unknown as AnyTool;
  return defineTool({
    ...definition,
    approval: () => "not-applicable",
    description:
      "Save one specific fact from the sourceSequence message of the current silent batch: a fact, a preference, first-hand experience, an event, a plan or a useful link with context. Special importance is not required, guesses are forbidden. Sensitive facts are not saved here.",
    inputSchema: reviewRememberSchema(scope),
    async execute(input, ctx) {
      if (ctx.session.auth.current?.attributes.groupType === "external") {
        const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
        if (!identity) throw new AppError(
          "AGENT_GROUP_TOOL_FORBIDDEN",
          "Текущая регистрация внешней группы не подтверждена",
        );
        await authorizeCurrentExternalGroupCapability(identity, "remember");
      }
      return await definition.execute(input, ctx);
    },
  }) as unknown as AnyTool;
}

async function authorizeReviewRead(ctx: ToolContext, capability: ExternalGroupToolName): Promise<void> {
  if (ctx.session.auth.current?.attributes.groupType !== "external") return;
  const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
  if (!identity) throw new AppError(
    "AGENT_GROUP_TOOL_FORBIDDEN",
    "Текущая регистрация внешней группы не подтверждена",
  );
  // Descriptor grants are snapshots; every read must authorize against the live registration.
  await authorizeCurrentExternalGroupCapability(identity, capability);
}

function reviewRead(
  capability: ExternalGroupToolName,
  definition: AnyTool,
): AnyTool {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      await authorizeReviewRead(ctx, capability);
      return await definition.execute(input, ctx);
    },
  }) as unknown as AnyTool;
}

export function buildMemoryReviewToolSurface(
  scope: MemoryScope,
  externalCapabilities?: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyTool>> {
  const allowed = (name: ExternalGroupToolName) =>
    externalCapabilities === undefined || externalCapabilities.has(name);
  const surface: Record<string, AnyTool> = {};
  if (allowed("list_memories")) {
    surface.manage_memory = actionView({
      actions: ["list"],
      authorize: async (ctx) => await authorizeReviewRead(ctx, "list_memories"),
      definition: manageMemory as unknown as AnyTool,
      presentation: manageMemoryPresentation(["list"]),
      toolName: "manage_memory",
    });
  }
  const threadActions = MEMORY_THREAD_READING_ACTIONS.filter((action) => allowed(EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS[action]));
  if (threadActions.length > 0) {
    surface.manage_memory_thread = actionView({
      actions: threadActions,
      authorize: async (ctx, action) => await authorizeReviewRead(ctx, EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS[action]),
      definition: manageMemoryThread as unknown as AnyTool,
      presentation: manageMemoryThreadPresentation(threadActions),
      toolName: "manage_memory_thread",
    });
  }
  if (allowed("remember")) surface.remember = reviewRemember(scope);
  if (allowed("search_memories")) {
    surface.search_memories = reviewRead(
      "search_memories",
      searchMemories as unknown as AnyTool,
    );
  }
  return wrapModelFacingToolMap(surface);
}
