/**
 * The family's skill library from a member's private chat: list, view, save, checkout, rollback,
 * enable, disable, delete — without confirmation buttons.
 *
 * Exports:
 * - `manage_skill`: the tool, in a family member's private chat.
 * - `requireManageSkillInput`: the one parser of its input.
 *
 * Key constructs:
 * - Any member saves a skill from a workspace folder; it becomes the current version at once and is
 *   enabled for its author. Everyone else enables it for themselves; a family group gets it from its
 *   list. A new version, a rollback or a deletion is the author's or the owner's.
 * - The application, not the model, sends a notice of every change to whom it concerns
 *   (`family-skills/family-skill-notices.ts`). An external group's skills stay with the owner
 *   (`manage_telegram_group`).
 */
import { z } from "zod";

import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { FAMILY_SKILL_LIMITS, SKILL_NAME_PATTERN, validateSkillPackage } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { requirePrivateTelegramMember } from "../family-context.js";
import { requireNoDraftPathReference } from "../family-skills/draft-path-check.js";
import { familySkillChanges, type FamilySkillActor } from "../family-skills/family-skill-changes.js";
import { familySkillRepository } from "../family-skills/family-skill-repository.js";
import { familySkillUsage } from "../family-skills/family-skill-usage.js";
import { isServiceSkillName } from "../family-skills/service-skills.js";
import { readWorkspaceSkillFolder, skillManifest, writeWorkspaceSkillFolder } from "../family-skills/workspace-skill-folder.js";
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
const ACTIONS = ["checkout", "delete", "disable", "enable", "list", "rollback", "save", "view"] as const;
const SCOPES = ["personal", "family"] as const;
const TARGETS = ["me", "family_group"] as const;
const FIELDS = ["action", "group", "name", "path", "scope", "sourceUrl", "target", "version"] as const;
const SOURCE_URL_MAX_LENGTH = 2_000;

const manageSkillSchema = z.object({
  action: z.enum(ACTIONS).describe("list, view, save, checkout, rollback, enable, disable or delete."),
  group: z.string().optional().describe("Only with target=family_group: the telegramChatId of the family group from list."),
  name: z.string().optional().describe("The family skill's name: for view, checkout, rollback, enable, disable, delete."),
  path: z.string().optional().describe("Only for save: the skill folder relative to the scope root, for example skills/weather."),
  scope: z.enum(SCOPES).optional().describe("Only for save: the workspace of the folder, personal or family."),
  sourceUrl: z.string().optional().describe("Only for save: the address the skill was downloaded from. Do not pass it for a skill you wrote."),
  target: z.enum(TARGETS).optional().describe("Only for enable and disable: me (this person's chats) or family_group."),
  version: z.number().int().positive().optional().describe("Only for rollback: the version number from view."),
}).strict();

export type ManageSkillInput =
  | { readonly action: "list" }
  | { readonly action: "checkout" | "delete" | "view"; readonly name: string }
  | { readonly action: "rollback"; readonly name: string; readonly version: number }
  | { readonly action: "disable" | "enable"; readonly name: string; readonly target: "me" }
  | { readonly action: "disable" | "enable"; readonly group: string; readonly name: string; readonly target: "family_group" }
  | { readonly action: "save"; readonly path: string; readonly scope: (typeof SCOPES)[number]; readonly sourceUrl?: string };

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
  if (action === "save") {
    only(["path", "scope", "sourceUrl"]);
    return {
      action,
      path: requiredString(input, "path", INPUT_ERROR_CODE, "skills/weather", { maxLength: 512 }),
      scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: requireSourceUrl(input.sourceUrl) }),
    };
  }
  if (action === "rollback") {
    only(["name", "version"]);
    const version = input.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
      toolInputError(INPUT_ERROR_CODE, "Для rollback передайте version: номер версии из ответа view");
    }
    return { action, name: requireName(input), version };
  }
  if (action === "enable" || action === "disable") {
    const target = requiredEnum(input, "target", TARGETS, INPUT_ERROR_CODE);
    if (target === "me") {
      only(["name", "target"]);
      return { action, name: requireName(input), target };
    }
    only(["group", "name", "target"]);
    return { action, group: requiredString(input, "group", INPUT_ERROR_CODE, "-1001234567890", { maxLength: 32 }), name: requireName(input), target };
  }
  only(["name"]);
  return { action, name: requireName(input) };
}

function builtInSkillChangeRefused(name: string): AppError {
  return new AppError("AGENT_SKILL_BUILT_IN",
    `${name} — встроенный скилл: он работает в личных и семейных чатах всегда, его не включают и не меняют`, { details: { name } });
}

// The procedure (prepare a folder, save, enable) is in the service skill skill-manager; the private
// surface's tool descriptions share one size budget.
const TOOL_DESCRIPTION = [
  "The family's skill library, without confirmation: list, view (versions), save (a workspace skill folder becomes the skill's current version at once; a new skill is enabled for you),",
  "checkout (writes the current version into skills/<name>/ in your personal workspace for editing), rollback, enable and disable (target me, or family_group with its group from list), delete.",
  "A new version, a rollback or a deletion is the author's or the owner's. Changes work from the next message. Load skill-manager first.",
].join(" ");

function actorOf(ctx: ToolContext, familyId: string, userId: string): FamilySkillActor {
  return { familyId, operationKey: `${ctx.session.turn.id}:${ctx.callId}`, userId };
}

async function familyGroups(familyId: string): Promise<Array<{ readonly group: string; readonly title: string }>> {
  return (await database().query<{ telegram_chat_id: string; title: string }>(
    "SELECT telegram_chat_id, title FROM telegram_groups WHERE family_id = $1 AND type = 'family_private' ORDER BY title",
    [familyId],
  )).rows.map((row) => ({ group: row.telegram_chat_id, title: row.title }));
}

export default defineTool({
  approval: () => "not-applicable",
  description: TOOL_DESCRIPTION,
  inputSchema: manageSkillSchema,
  async execute(input, ctx) {
    const parsed = requireManageSkillInput(input);
    const member = requirePrivateTelegramMember(ctx);
    const actor = actorOf(ctx, member.familyId, member.userId);
    if (parsed.action !== "list" && parsed.action !== "save" && isGroupSafeSkillName(parsed.name)) {
      throw builtInSkillChangeRefused(parsed.name);
    }
    switch (parsed.action) {
      case "list": {
        const family = await familySkillRepository.list(member.familyId, member.userId);
        const usage = await familySkillUsage(member.familyId, family.map((skill) => skill.name));
        return {
          builtIn: [...GROUP_SAFE_SKILL_NAMES],
          family: family.map((skill) => ({ ...skill, usage: usage.get(skill.name) })),
          familyGroups: await familyGroups(member.familyId),
        };
      }
      case "view":
        return await familySkillRepository.versions(member.familyId, member.userId, parsed.name);
      case "save": {
        const files = await readWorkspaceSkillFolder(ctx, { path: parsed.path, scope: parsed.scope });
        const skill = validateSkillPackage({ files, limits: FAMILY_SKILL_LIMITS });
        if (isGroupSafeSkillName(skill.name) || isImageGenerationSkillName(skill.name) || isServiceSkillName(skill.name)) {
          throw new AppError("AGENT_SKILL_NAME_TAKEN", `Имя ${skill.name} занято встроенным скиллом. Переименуйте скилл в SKILL.md`);
        }
        requireNoDraftPathReference(skill);
        const saved = await familySkillChanges.save({
          actor, origin: parsed.sourceUrl === undefined ? { kind: "authored" } : { kind: "downloaded", url: parsed.sourceUrl }, skill,
        });
        return {
          description: skill.description,
          files: skill.files.map(({ executable, path, size }) => ({ executable, path, size })),
          name: skill.name,
          status: saved.newSkill ? "saved_and_enabled_for_you" : saved.previousVersion === saved.version ? "unchanged" : "current_version_replaced",
          version: saved.version,
          ...(saved.previousVersion === null || saved.previousVersion === saved.version ? {} : { previousVersion: saved.previousVersion }),
          worksFrom: "next_message",
        };
      }
      case "checkout": {
        const current = await familySkillRepository.currentPackage(member.familyId, parsed.name);
        const path = `skills/${parsed.name}`;
        await writeWorkspaceSkillFolder(ctx, {
          files: [
            { content: Buffer.from(skillManifest({ ...current, name: parsed.name }), "utf8"), path: "SKILL.md" },
            ...current.files,
          ],
          path,
        });
        return { files: ["SKILL.md", ...current.files.map((file) => file.path)], path, scope: "personal", version: current.version };
      }
      case "rollback": {
        const { previousVersion } = await familySkillChanges.rollback({ actor, name: parsed.name, version: parsed.version });
        return { name: parsed.name, previousVersion, version: parsed.version, worksFrom: "next_message" };
      }
      case "enable":
      case "disable": {
        const enabled = parsed.action === "enable";
        if (parsed.target === "me") {
          const { changed } = await familySkillChanges.setEnabledForSelf({ actor, enabled, name: parsed.name });
          return { changed, name: parsed.name, target: "me", worksFrom: "next_message" };
        }
        const { changed, title } = await familySkillChanges.setInFamilyGroup({
          actor, enabled, name: parsed.name, telegramChatId: parsed.group,
        });
        return { changed, group: title, name: parsed.name, target: "family_group", worksFrom: "next_message" };
      }
      case "delete":
        await familySkillChanges.remove({ actor, name: parsed.name });
        return { name: parsed.name, status: "deleted" };
    }
  },
});
