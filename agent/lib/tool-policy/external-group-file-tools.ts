/**
 * Execution-time boundary for the runtime's filesystem built-ins in external groups.
 *
 * Exports:
 * - `createExternalGroupFileTools`: testable same-name wrappers around the runtime's default tools.
 * - `EXTERNAL_GROUP_FILE_TOOLS`: production wrappers backed by live workspace authorization.
 *
 * Key constructs:
 * - Every execution resolves the current external registration before touching the sandbox.
 * - Model paths are canonical absolute paths under the exact `/workspace/group` root.
 * - `read_file` alone may read a currently granted dynamic skill package through canonical `$HOME`.
 * - Host-side component inspection rejects symlinks before the native executor runs.
 */
import { z } from "zod";

import { type ToolContext, type ToolDefinition, defineTool } from "../../runtime/tool.js";
import {
  glob as runtimeGlob,
  grep as runtimeGrep,
  readFile as runtimeReadFile,
  writeFile as runtimeWriteFile,
} from "../../runtime/tools/defaults.js";
import { GLOB_INPUT_SCHEMA } from "../../runtime/tools/glob.js";
import { GREP_INPUT_SCHEMA } from "../../runtime/tools/grep.js";
import { READ_FILE_INPUT_SCHEMA } from "../../runtime/tools/read-file.js";
import { WRITE_FILE_INPUT_SCHEMA } from "../../runtime/tools/write-file.js";

import { SKILL_NAME_PATTERN } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import type { GroupSafeSkillName } from "../group-skills/group-skill-catalog.js";
import { groupSkillPolicyRepository } from "../group-skills/group-skill-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import {
  type WorkspaceAuthorization,
  workspaceRepository,
} from "../workspaces/workspace-repository.js";
import {
  createScopedFileTools,
  throwFileToolExecutionError,
} from "./scoped-file-tools.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ExternalGroupFileToolName = "glob" | "grep" | "read_file" | "write_file";

interface ExternalGroupFileToolDependencies {
  authorize(auth: WorkspaceAuthorization): Promise<string>;
  defaults: Readonly<Record<ExternalGroupFileToolName, AnyToolDefinition>>;
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

const MODEL_SKILL_ROOT = "$HOME/.agents/skills";
const ABSOLUTE_SKILL_ROOT_MARKER = "/.agents/skills";
const FILE_PATH_MAX_CHARACTERS = 4_096;

function forbiddenPath(): AppError {
  return new AppError(
    "AGENT_GROUP_FILE_PATH_FORBIDDEN",
    "Файловая операция разрешена только внутри workspace текущей внешней группы",
  );
}

function forbiddenSkill(): AppError {
  return new AppError(
    "AGENT_GROUP_SKILL_FORBIDDEN",
    "Этот skill не разрешён в текущей группе. Обратитесь к владельцу агента",
  );
}

interface SkillFilePath {
  canonicalPath: string;
  skillName: GroupSafeSkillName;
}

function skillPathSuffix(value: string): string | null {
  if (value === MODEL_SKILL_ROOT) return "";
  if (value.startsWith(`${MODEL_SKILL_ROOT}/`)) {
    return value.slice(MODEL_SKILL_ROOT.length + 1);
  }
  if (!value.startsWith("/")) return null;

  // The announced absolute HOME is untrusted and discarded rather than delegated to the native tool.
  const markerIndex = value.indexOf(ABSOLUTE_SKILL_ROOT_MARKER);
  if (markerIndex < 0) return null;
  const suffixStart = markerIndex + ABSOLUTE_SKILL_ROOT_MARKER.length;
  if (value.length === suffixStart) return "";
  if (value[suffixStart] !== "/") return null;
  return value.slice(suffixStart + 1);
}

function parseSkillFilePath(value: unknown): SkillFilePath | null {
  if (typeof value !== "string") return null;
  const suffix = skillPathSuffix(value);
  if (suffix === null) return null;
  if (
    value.length === 0 ||
    value.length > FILE_PATH_MAX_CHARACTERS ||
    value.includes("\0")
  ) {
    throw forbiddenPath();
  }

  // Every segment must remain a literal package-relative component after prefix removal.
  const [skillName, ...relativeComponents] = suffix.split("/");
  if (skillName === undefined || !SKILL_NAME_PATTERN.test(skillName)) throw forbiddenSkill();
  if (
    relativeComponents.length === 0 ||
    relativeComponents.some((component) =>
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.includes("\\")
    )
  ) {
    throw forbiddenPath();
  }
  return {
    canonicalPath: `${MODEL_SKILL_ROOT}/${skillName}/${relativeComponents.join("/")}`,
    skillName,
  };
}

async function readAuthorizedSkillFile(
  dependencies: ExternalGroupFileToolDependencies,
  skillPath: SkillFilePath,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const authorization = requireWorkspaceAuthorization(ctx);

  // Re-authorize the external registration before consulting or using its live skill policy.
  await dependencies.authorize(authorization);
  if (authorization.groupId === null) throw forbiddenSkill();
  const allowed = await dependencies.loadGroupSkillAllowlist(authorization.groupId);
  if (!allowed.has(skillPath.skillName)) throw forbiddenSkill();

  // The native tool resolves canonical `$HOME` and retains native pagination, output, and read stamps.
  try {
    return await dependencies.defaults.read_file.execute(
      { ...input as object, filePath: skillPath.canonicalPath },
      ctx,
    );
  } catch (error) {
    throwFileToolExecutionError(error, "read_file");
  }
}

// The native field texts name /workspace and $HOME, which this group cannot use. Only the texts
// change: validation is the native one, and the scoped wrappers still reject any other root.
const GROUP_GLOB_INPUT_SCHEMA = GLOB_INPUT_SCHEMA.extend({
  path: z.string().describe("The folder to search inside /workspace/group; without the field the whole /workspace/group is searched.").optional(),
});
const GROUP_GREP_INPUT_SCHEMA = GREP_INPUT_SCHEMA.extend({
  path: z.string().describe("The folder or file to search inside /workspace/group; without the field the whole /workspace/group is searched.").optional(),
});
const GROUP_READ_FILE_INPUT_SCHEMA = READ_FILE_INPUT_SCHEMA.extend({
  filePath: z.string().describe("An absolute path inside /workspace/group, for example /workspace/group/notes.md, or the path of a file of a permitted skill."),
});
const GROUP_WRITE_FILE_INPUT_SCHEMA = WRITE_FILE_INPUT_SCHEMA.extend({
  filePath: z.string().describe("An absolute path inside /workspace/group, for example /workspace/group/report.html."),
});

export function createExternalGroupFileTools(
  dependencies: ExternalGroupFileToolDependencies,
): Readonly<Record<ExternalGroupFileToolName, AnyToolDefinition>> {
  const workspaceTools = createScopedFileTools({
    authorize: async (auth) => [{
      hostRoot: await dependencies.authorize(auth),
      mountPoint: "group",
    }],
    defaultMountPoint: "group",
    defaults: dependencies.defaults,
    forbiddenPath,
  });
  return {
    glob: defineTool({
      ...workspaceTools.glob,
      description: "Find files by a glob pattern only inside the absolute path /workspace/group.",
      inputSchema: GROUP_GLOB_INPUT_SCHEMA,
    }),
    grep: defineTool({
      ...workspaceTools.grep,
      description: "Find text only inside files under the absolute path /workspace/group.",
      inputSchema: GROUP_GREP_INPUT_SCHEMA,
    }),
    read_file: defineTool({
      ...dependencies.defaults.read_file,
      description: "Read a file by an absolute filePath inside /workspace/group or a supporting file of an already permitted dynamic skill.",
      inputSchema: GROUP_READ_FILE_INPUT_SCHEMA,
      async execute(input, ctx) {
        const skillPath = parseSkillFilePath((input as { filePath?: unknown }).filePath);
        if (skillPath === null) return await workspaceTools.read_file.execute(input, ctx);
        return await readAuthorizedSkillFile(dependencies, skillPath, input, ctx);
      },
    }),
    write_file: defineTool({
      ...workspaceTools.write_file,
      description: "Create or change a file only by an absolute filePath inside /workspace/group.",
      inputSchema: GROUP_WRITE_FILE_INPUT_SCHEMA,
    }),
  };
}

export const EXTERNAL_GROUP_FILE_TOOLS = createExternalGroupFileTools({
  authorize: async (auth) => await workspaceRepository.externalGroupRoot(auth),
  defaults: {
    glob: runtimeGlob,
    grep: runtimeGrep,
    read_file: runtimeReadFile,
    write_file: runtimeWriteFile,
  },
  loadGroupSkillAllowlist: (groupId) =>
    groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});
