/**
 * External Telegram group execution policy.
 *
 * Exports:
 * - `resolveExternalGroupToolPolicy`: reads a fail-closed policy from verified Eve auth.
 * - `createExternalGroupToolOverrides`: creates step-scoped action-aware tool overrides.
 */
import type { SessionAuth } from "eve/context";
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import inspectWorkspaceImage from "../../tools/inspect_workspace_image.js";
import listMemories from "../../tools/list_memories.js";
import manageMemory from "../../tools/manage_memory.js";
import remember from "../../tools/remember.js";
import searchMemories from "../../tools/search_memories.js";
import sendWorkspaceFile from "../../tools/send_workspace_file.js";
import { AppError } from "../app-error.js";
import { removeGroupFileTool } from "../workspaces/remove-group-file-tool.js";
import {
  CONTROLLED_TOOL_NAMES,
  isExternalGroupToolName,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

interface RestrictedGroupToolPolicy {
  allowed: ReadonlySet<ExternalGroupToolName>;
  restricted: true;
}

type GroupToolPolicy = RestrictedGroupToolPolicy | { restricted: false };
type AnyToolDefinition = ToolDefinition<any, any>;
type DirectExternalToolName = Exclude<ExternalGroupToolName, `manage_memory.${string}`>;

const DIRECT_TOOL_DEFINITIONS: Readonly<Record<DirectExternalToolName, AnyToolDefinition>> = {
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  remove_group_file: removeGroupFileTool as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
};

const DENIED_TOOL_INPUT = z.record(z.string(), z.unknown());

function externalAuth(auth: SessionAuth) {
  // Group type, not family role, defines isolation; owners remain restricted inside external groups.
  const isExternal = (groupType: unknown) =>
    groupType === "external_private" || groupType === "external_public";
  if (isExternal(auth.current?.attributes.groupType)) return auth.current;
  if (!auth.current && isExternal(auth.initiator?.attributes.groupType)) return auth.initiator;
  return null;
}

export function resolveExternalGroupToolPolicy(auth: SessionAuth): GroupToolPolicy {
  const caller = externalAuth(auth);
  if (!caller) return { restricted: false };

  const groupType = caller.attributes.groupType;
  const rawAllowlist = caller.attributes.toolAllowlist;
  const validGroupType = groupType === "external_private" || groupType === "external_public";
  const validAllowlist =
    Array.isArray(rawAllowlist) && rawAllowlist.every((name) => isExternalGroupToolName(name));

  // Corrupt or incomplete trusted policy must deny everything rather than expose static tools.
  return {
    allowed: new Set(validGroupType && validAllowlist ? rawAllowlist : []),
    restricted: true,
  };
}

function assertExternalGroupCapabilityAllowed(
  ctx: ToolContext,
  capability: ExternalGroupToolName,
): void {
  const policy = resolveExternalGroupToolPolicy(ctx.session.auth);
  if (!policy.restricted || !policy.allowed.has(capability)) {
    throw new AppError(
      "AGENT_GROUP_TOOL_FORBIDDEN",
      "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
    );
  }
}

function deniedTool(toolName: string): AnyToolDefinition {
  return defineTool({
    description: `Инструмент ${toolName} недоступен в текущей внешней группе.`,
    inputSchema: DENIED_TOOL_INPUT,
    async execute() {
      throw new AppError(
        "AGENT_GROUP_TOOL_FORBIDDEN",
        "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
      );
    },
  }) as unknown as AnyToolDefinition;
}

function allowedDirectTool(
  capability: DirectExternalToolName,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      assertExternalGroupCapabilityAllowed(ctx, capability);
      return await definition.execute(input, ctx);
    },
  });
}

function allowedMemoryTool(): AnyToolDefinition {
  return defineTool({
    ...(manageMemory as unknown as AnyToolDefinition),
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "edit" && action !== "delete" && action !== "undo") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с памятью. Повторите запрос",
        );
      }
      assertExternalGroupCapabilityAllowed(ctx, `manage_memory.${action}`);
      return await (manageMemory as unknown as AnyToolDefinition).execute(input, ctx);
    },
  });
}

function buildExternalGroupToolOverrides(
  allowed: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyToolDefinition>> {
  // Every static app, network, shell, and orchestration capability is overridden fail-closed.
  const overrides: Record<string, AnyToolDefinition> = Object.fromEntries(
    CONTROLLED_TOOL_NAMES.map((toolName) => {
      if (toolName === "manage_memory") {
        const hasMemoryCapability = [...allowed].some((name) => name.startsWith("manage_memory."));
        return [toolName, hasMemoryCapability ? allowedMemoryTool() : deniedTool(toolName)];
      }
      if (isExternalGroupToolName(toolName)) {
        return [
          toolName,
          allowed.has(toolName)
            ? allowedDirectTool(toolName, DIRECT_TOOL_DEFINITIONS[toolName])
            : deniedTool(toolName),
        ];
      }
      return [toolName, deniedTool(toolName)];
    }),
  );

  // This capability has no global static descriptor because trusted sandboxes already use Bash.
  if (allowed.has("remove_group_file")) {
    overrides.remove_group_file = allowedDirectTool(
      "remove_group_file",
      DIRECT_TOOL_DEFINITIONS.remove_group_file,
    );
  }
  return overrides;
}

function allowlistKey(allowed: ReadonlySet<ExternalGroupToolName>): string {
  return [...allowed].sort().join("\u0000");
}

const EXTERNAL_GROUP_OVERRIDE_SETS = new Map<string, Readonly<Record<string, AnyToolDefinition>>>();
EXTERNAL_GROUP_OVERRIDE_SETS.set("", buildExternalGroupToolOverrides(new Set()));

export function createExternalGroupToolOverrides(
  allowed: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyToolDefinition>> {
  if ([...allowed].some((name) => !isExternalGroupToolName(name))) {
    return EXTERNAL_GROUP_OVERRIDE_SETS.get("")!;
  }
  const key = allowlistKey(allowed);
  const cached = EXTERNAL_GROUP_OVERRIDE_SETS.get(key);
  if (cached) return cached;
  const overrides = buildExternalGroupToolOverrides(allowed);
  EXTERNAL_GROUP_OVERRIDE_SETS.set(key, overrides);
  return overrides;
}
