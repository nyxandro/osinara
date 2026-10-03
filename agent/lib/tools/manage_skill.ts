/**
 * The owner's own skills: list, view, store from a workspace folder, confirm, enable, disable, delete.
 *
 * Exports:
 * - `manage_skill`: the tool, available only to the owner in the private chat.
 * - `requireManageSkillInput`: the one parser of its input, shared with the approval card.
 *
 * Key constructs:
 * - A skill folder is checked like a built-in skill and stored as a new version; nothing changes
 *   until the owner confirms that version with a button (`activate`). The current version keeps
 *   working meanwhile, and every earlier version stays for a rollback.
 * - The confirmed skill works from the next turn on, in private and family chats; an external
 *   group gets it only when the owner adds it to that group's skills.
 */
import { z } from "zod";

import { defineTool } from "../../runtime/tool.js";
import { FAMILY_SKILL_LIMITS, SKILL_NAME_PATTERN, validateSkillPackage } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { familySkillRepository } from "../family-skills/family-skill-repository.js";
import { readWorkspaceSkillFolder } from "../family-skills/workspace-skill-folder.js";
import { GROUP_SAFE_SKILL_NAMES, isGroupSafeSkillName } from "../group-skills/group-skill-catalog.js";
import { isImageGenerationSkillName } from "../image-generation/image-generation-skill.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_SKILL_INPUT_INVALID";
const ACTIONS = ["activate", "delete", "disable", "enable", "list", "stage", "view"] as const;
const SCOPES = ["personal", "family"] as const;
const FIELDS = ["action", "name", "path", "scope", "sourceUrl", "version"] as const;
const SOURCE_URL_MAX_LENGTH = 2_000;

const manageSkillSchema = z.object({
  action: z.enum(ACTIONS).describe("list, view, stage, activate, enable, disable или delete."),
  name: z.string().optional().describe("Имя скилла семьи: для view, activate, enable, disable, delete."),
  path: z.string().optional().describe("Только для stage: папка скилла относительно корня scope, например skills/weather."),
  scope: z.enum(SCOPES).optional().describe("Только для stage: рабочая область папки — personal или family."),
  sourceUrl: z.string().optional().describe("Только для stage: адрес, откуда скилл скачан. Не передавай для скилла, написанного тобой."),
  version: z.number().int().positive().optional().describe("Только для activate: номер версии из ответа stage или view."),
}).strict();

export type ManageSkillInput =
  | { readonly action: "list" }
  | { readonly action: "delete" | "disable" | "enable" | "view"; readonly name: string }
  | { readonly action: "activate"; readonly name: string; readonly version: number }
  | { readonly action: "stage"; readonly path: string; readonly scope: (typeof SCOPES)[number]; readonly sourceUrl?: string };

function requireName(input: Record<string, unknown>): string {
  const name = requiredString(input, "name", INPUT_ERROR_CODE, "weather", { maxLength: 63 });
  if (!SKILL_NAME_PATTERN.test(name)) {
    toolInputError(INPUT_ERROR_CODE, "Имя скилла: строчные латинские буквы, цифры и дефисы, до 63 символов");
  }
  return name;
}

function requireSourceUrl(value: unknown): string {
  let url: URL;
  try {
    if (typeof value !== "string" || value.length > SOURCE_URL_MAX_LENGTH) throw new Error("not a string");
    url = new URL(value);
  } catch {
    return toolInputError(INPUT_ERROR_CODE, "sourceUrl должен быть адресом http или https не длиннее 2000 символов");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    toolInputError(INPUT_ERROR_CODE, "sourceUrl должен быть адресом http или https");
  }
  return url.toString();
}

export function requireManageSkillInput(raw: unknown): ManageSkillInput {
  const input = requireInputRecord(raw, "manage_skill", INPUT_ERROR_CODE);
  const action = requireAction(input, "manage_skill", ACTIONS, INPUT_ERROR_CODE);
  const only = (fields: readonly string[]) => requireOnlyFields(input, ["action", ...fields], `manage_skill action=${action}`, INPUT_ERROR_CODE);
  requireOnlyFields(input, FIELDS, "manage_skill", INPUT_ERROR_CODE);
  if (action === "list") {
    only([]);
    return { action };
  }
  if (action === "stage") {
    only(["path", "scope", "sourceUrl"]);
    return {
      action,
      path: requiredString(input, "path", INPUT_ERROR_CODE, "skills/weather", { maxLength: 512 }),
      scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: requireSourceUrl(input.sourceUrl) }),
    };
  }
  if (action === "activate") {
    only(["name", "version"]);
    const version = input.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
      toolInputError(INPUT_ERROR_CODE, "Для activate передайте version: номер версии из ответа stage или view");
    }
    return { action, name: requireName(input), version };
  }
  only(["name"]);
  return { action, name: requireName(input) };
}

// The procedure (prepare a folder, stage, activate) is in the owner's private-chat instructions;
// the private surface's tool descriptions share one size budget.
const TOOL_DESCRIPTION = [
  "Скиллы семьи: list, view, stage (папка скилла с SKILL.md из рабочей области сохраняется новой версией и ещё не работает),",
  "activate (version из stage или view; после кнопки владельца работает со следующего хода, так же откатывается), enable, disable, delete.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = requireManageSkillInput(toolInput);
    return parsed.action === "list" || parsed.action === "view" || parsed.action === "stage" ? "not-applicable" : "user-approval";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageSkillSchema,
  async execute(input, ctx) {
    const parsed = requireManageSkillInput(input);
    const owner = requirePrivateTelegramOwner(ctx);
    switch (parsed.action) {
      case "list":
        return { builtIn: [...GROUP_SAFE_SKILL_NAMES], family: await familySkillRepository.list(owner.familyId) };
      case "view":
        return await familySkillRepository.versions(owner.familyId, parsed.name);
      case "stage": {
        const files = await readWorkspaceSkillFolder(ctx, { path: parsed.path, scope: parsed.scope });
        const skill = validateSkillPackage({ files, limits: FAMILY_SKILL_LIMITS });
        if (isGroupSafeSkillName(skill.name) || isImageGenerationSkillName(skill.name)) {
          throw new AppError("AGENT_SKILL_NAME_TAKEN", `Имя ${skill.name} занято встроенным скиллом. Переименуйте скилл в SKILL.md`);
        }
        const stored = await familySkillRepository.stage({
          createdBy: owner.userId,
          familyId: owner.familyId,
          origin: parsed.sourceUrl === undefined ? { kind: "authored" } : { kind: "downloaded", url: parsed.sourceUrl },
          skill,
        });
        return {
          description: skill.description,
          files: skill.files.map(({ executable, path, size }) => ({ executable, path, size })),
          name: skill.name,
          stored: stored.created ? "new_version" : "same_as_latest",
          version: stored.version,
          nextStep: `Скилл ещё не работает. Чтобы включить эту версию, вызови manage_skill с action=activate, name=${skill.name}, version=${stored.version}: владелец подтвердит кнопкой.`,
        };
      }
      case "activate": {
        const { previousVersion } = await familySkillRepository.activate({
          familyId: owner.familyId, name: parsed.name, requestedBy: owner.userId, version: parsed.version,
        });
        return { name: parsed.name, previousVersion, status: "active_from_next_turn", version: parsed.version };
      }
      case "enable":
      case "disable":
        await familySkillRepository.setEnabled({
          enabled: parsed.action === "enable", familyId: owner.familyId, name: parsed.name, requestedBy: owner.userId,
        });
        return { name: parsed.name, status: parsed.action === "enable" ? "enabled_from_next_turn" : "disabled_from_next_turn" };
      case "delete":
        await familySkillRepository.remove({ familyId: owner.familyId, name: parsed.name, requestedBy: owner.userId });
        return { name: parsed.name, status: "deleted" };
    }
  },
});
