/**
 * Least-privilege tool surface for silent memory review.
 *
 * Exports:
 * - `MEMORY_REVIEW_DENIED_TOOL_NAMES`: native Eve tools explicitly overridden for review turns.
 * - `buildMemoryReviewToolSurface`: memory reads and source-backed normal-sensitivity writes only.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { wrapModelFacingToolMap } from "../model-facing-tool.js";
import listMemories from "../tools/list_memories.js";
import listMemoryThreads from "../tools/list_memory_threads.js";
import readMemoryThread from "../tools/read_memory_thread.js";
import remember from "../tools/remember.js";
import searchMemories from "../tools/search_memories.js";
import searchMemoryThreads from "../tools/search_memory_threads.js";
import { rememberInputSchema } from "../remember-contract.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { resolveExternalGroupPolicyIdentity } from "../tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";

type AnyTool = ToolDefinition<any, any>;

export const MEMORY_REVIEW_DENIED_TOOL_NAMES = [
  "agent",
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
] as const;

const deniedInput = z.record(z.string(), z.unknown());
const reviewRememberSchema = rememberInputSchema.refine(
  (input) => input.basis === "agent_inferred" && input.sensitivity === "normal" &&
    input.sourceSequence !== undefined,
  {
    message:
      "AGENT_MEMORY_REVIEW_INPUT_INVALID: Для тихой проверки обязательны sourceSequence, basis agent_inferred и sensitivity normal",
  },
);

function deniedTool(name: string): AnyTool {
  return defineTool({
    description: `Инструмент ${name} недоступен во время тихой проверки памяти.`,
    inputSchema: deniedInput,
    async execute() {
      throw new AppError(
        "AGENT_MEMORY_REVIEW_TOOL_FORBIDDEN",
        "Во время тихой проверки доступны только инструменты памяти",
      );
    },
  }) as unknown as AnyTool;
}

function reviewRemember(): AnyTool {
  const definition = remember as unknown as AnyTool;
  return defineTool({
    ...definition,
    approval: () => "not-applicable",
    description:
      "Сохранить одно конкретное сведение из sourceSequence текущего тихого batch: факт, предпочтение, личный опыт, событие, план или полезную ссылку с контекстом. Особая важность не требуется, догадки запрещены. Разрешена только normal sensitivity.",
    inputSchema: reviewRememberSchema,
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

function reviewRead(
  capability: ExternalGroupToolName,
  definition: AnyTool,
): AnyTool {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      if (ctx.session.auth.current?.attributes.groupType === "external") {
        const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
        if (!identity) throw new AppError(
          "AGENT_GROUP_TOOL_FORBIDDEN",
          "Текущая регистрация внешней группы не подтверждена",
        );
        // Descriptor grants are snapshots; every read must authorize against the live registration.
        await authorizeCurrentExternalGroupCapability(identity, capability);
      }
      return await definition.execute(input, ctx);
    },
  }) as unknown as AnyTool;
}

export function buildMemoryReviewToolSurface(
  externalCapabilities?: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyTool>> {
  const allowed = (name: ExternalGroupToolName) =>
    externalCapabilities === undefined || externalCapabilities.has(name);
  const surface: Record<string, AnyTool> = {};
  if (allowed("list_memories")) {
    surface.list_memories = reviewRead("list_memories", listMemories as unknown as AnyTool);
  }
  if (allowed("list_memory_threads")) {
    surface.list_memory_threads = reviewRead(
      "list_memory_threads",
      listMemoryThreads as unknown as AnyTool,
    );
  }
  if (allowed("read_memory_thread")) {
    surface.read_memory_thread = reviewRead(
      "read_memory_thread",
      readMemoryThread as unknown as AnyTool,
    );
  }
  if (allowed("remember")) surface.remember = reviewRemember();
  if (allowed("search_memories")) {
    surface.search_memories = reviewRead(
      "search_memories",
      searchMemories as unknown as AnyTool,
    );
  }
  if (allowed("search_memory_threads")) {
    surface.search_memory_threads = reviewRead(
      "search_memory_threads",
      searchMemoryThreads as unknown as AnyTool,
    );
  }
  for (const name of MEMORY_REVIEW_DENIED_TOOL_NAMES) surface[name] = deniedTool(name);
  return wrapModelFacingToolMap(surface);
}
