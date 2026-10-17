/**
 * Consolidated Telegram group administration tool.
 *
 * Export:
 * - `manage_telegram_group`: reads status and manages registration, context and policies.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root and nested JSON Schema unions.
 * - Required finite enums make the complete model contract machine-visible.
 * - One semantic parser validates every action before approval and execution.
 * - Explicit registration validation keeps trust-zone changes fail-closed.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../family-context.js";
import type { RegisteredGroupType } from "../family-access.js";
import { SKILL_NAME_PATTERN } from "../../runtime/skills/package-validation.js";
import { familySkillRepository } from "../family-skills/family-skill-repository.js";
import { grantableSkillNames, isWorkingSkill, skillGrantCatalog, skillNeedsBash } from "../family-skills/skill-grants.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import {
  GROUP_TITLE_MAX_LENGTH,
  TELEGRAM_GROUP_ID_PATTERN,
  TELEGRAM_GROUP_TITLE_CONTROL_PATTERN,
  TOOL_ALLOWLIST_MAX_SIZE,
} from "../telegram-group-registration.js";
import {
  GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES,
  isGrantableExternalGroupToolName,
  selectGrantableExternalGroupTools,
  unservableCapabilityReason,
} from "../tool-policy/grantable-group-capabilities.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_BASE_TOOLS,
  isExternalGroupToolName,
} from "../tool-policy/group-tool-catalog.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  requiredObjectField,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_GROUP_INPUT_INVALID";
const TOOL_ACTIONS = [
  "register",
  "remove",
  "start_new_context",
  "status",
  "update_policy",
  "update_skills",
] as const;
const GROUP_TYPES = ["family_private", "external"] as const;
const STANDARD_MESSAGE_MODES = ["addressed_only", "all"] as const;
const EXTERNAL_MESSAGE_MODES = [...STANDARD_MESSAGE_MODES, "owner_only"] as const;
const TOP_LEVEL_FIELDS = [
  "action",
  "messageMode",
  "registration",
  "skillAllowlist",
  "telegramChatId",
  "toolAllowlist",
] as const;
const REGISTRATION_FIELDS = ["messageMode", "telegramChatId", "title", "toolAllowlist", "type"] as const;

const registrationSchema = z.object({
  messageMode: z.enum(EXTERNAL_MESSAGE_MODES).optional().describe("Required inside registration: addressed_only, all or owner_only for external."),
  telegramChatId: z.string().optional().describe("Required exact negative Telegram chat ID of the group being registered."),
  title: z.string().optional().describe("Required display name of the group being registered."),
  toolAllowlist: z.array(z.enum(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES)).optional().describe("Only for registration.type=external; do not pass the field for family_private."),
  type: z.enum(GROUP_TYPES).optional().describe("Required trust zone type: family_private or external."),
}).strict();

const manageTelegramGroupSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe(
    "Choose exactly one action first; allowed values: register, remove, start_new_context, status, update_policy or update_skills.",
  ),
  messageMode: z.enum(EXTERNAL_MESSAGE_MODES).optional().describe(
    "Pass only with action=update_policy. For register use registration.messageMode; do not pass the field for other actions.",
  ),
  registration: registrationSchema.optional().describe(
    "Pass only with action=register. Omit registration entirely for other actions.",
  ),
  skillAllowlist: z.array(z.string()).optional().describe(
    "Pass only with action=update_skills: the full list of names from availableSafeSkills of the status answer; an empty array revokes all skills.",
  ),
  telegramChatId: z.string().optional().describe(
    "An exact negative ID is required for start_new_context, update_policy, update_skills and remove. Do not pass it for status; for register use registration.telegramChatId.",
  ),
  toolAllowlist: z.array(z.enum(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES)).optional().describe(
    "Pass at the top level only with action=update_policy. For an external register use registration.toolAllowlist; do not pass the field for other actions.",
  ),
}).strict();

function requireTelegramGroupId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !TELEGRAM_GROUP_ID_PATTERN.test(raw)) {
    toolInputError(INPUT_ERROR_CODE, `${label} должен быть строкой отрицательного Telegram chat ID группы, например -1001234567890`);
  }
  return raw;
}

function requireContextRotationGroupId(raw: unknown): string {
  if (typeof raw !== "string" || !TELEGRAM_GROUP_ID_PATTERN.test(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=start_new_context обязателен точный отрицательный telegramChatId. " +
        "Не угадывайте ID: сначала вызовите ровно {\"action\":\"status\"}, выберите нужную группу " +
        "и скопируйте её startNewContextInput вида " +
        "{\"action\":\"start_new_context\",\"telegramChatId\":\"-1001234567890\"}",
    );
  }
  return raw;
}

function requireExternalToolAllowlist(raw: unknown, policyLabel: string): string[] {
  if (!Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Для ${policyLabel} передайте toolAllowlist массивом разрешённых tools: ${GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
    );
  }
  if (raw.length > TOOL_ALLOWLIST_MAX_SIZE) {
    toolInputError(INPUT_ERROR_CODE, `toolAllowlist должен содержать не больше ${TOOL_ALLOWLIST_MAX_SIZE} tools`);
  }
  const names = raw.map((name) => {
    // A catalog capability that the active runtime cannot serve gets its own diagnosis, so the
    // owner learns the grant is impossible instead of reading it as a malformed payload.
    const reason = typeof name === "string" && isExternalGroupToolName(name) ? unservableCapabilityReason(name) : null;
    if (typeof name === "string" && reason !== null) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Capability ${name} недоступна: ${reason}. Выдать это право нельзя; передайте toolAllowlist без него`,
      );
    }
    if (typeof name !== "string" || !isGrantableExternalGroupToolName(name)) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Недопустимый toolAllowlist item. Используйте только: ${GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
      );
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    toolInputError(INPUT_ERROR_CODE, "toolAllowlist не должен содержать повторы");
  }
  return names;
}

function requireToolAllowlist(raw: unknown, groupType: RegisteredGroupType): string[] {
  // Family capabilities are policy-derived, so registration must not persist a model-provided list.
  if (groupType === "family_private") {
    if (raw !== undefined) {
      toolInputError(
        INPUT_ERROR_CODE,
        "Для type=family_private не передавайте toolAllowlist: семейная группа получает семейные инструменты по своим правилам",
      );
    }
    return [];
  }
  return requireExternalToolAllowlist(raw, groupType);
}

// Whether a name is a skill that exists now is checked when the list is saved: the family's own
// skills live in the database.
function requireSkillAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=update_skills передайте skillAllowlist массивом имён из availableSafeSkills ответа status",
    );
  }
  const names = raw.map((name) => {
    if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) {
      toolInputError(
        INPUT_ERROR_CODE,
        "Недопустимый skillAllowlist item. Используйте только имена из availableSafeSkills ответа status",
      );
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    toolInputError(INPUT_ERROR_CODE, "skillAllowlist не должен содержать повторы");
  }
  return names;
}

function requireRegistration(input: Record<string, unknown>) {
  const registration = requiredObjectField(
    input,
    "registration",
    INPUT_ERROR_CODE,
    "Для action=register передайте registration с type, telegramChatId, title, messageMode и при необходимости toolAllowlist",
  );
  requireOnlyFields(registration, REGISTRATION_FIELDS, "registration", INPUT_ERROR_CODE);
  const type = requiredEnum(registration, "type", GROUP_TYPES, INPUT_ERROR_CODE) as RegisteredGroupType;
  const common = {
    telegramChatId: requireTelegramGroupId(registration.telegramChatId, "registration.telegramChatId"),
    title: requiredString(registration, "title", INPUT_ERROR_CODE, "Семейный чат", {
      maxLength: GROUP_TITLE_MAX_LENGTH,
    }),
  };
  if (TELEGRAM_GROUP_TITLE_CONTROL_PATTERN.test(common.title)) {
    toolInputError(INPUT_ERROR_CODE, "registration.title должен состоять из одной строки без управляющих символов");
  }
  if (type === "family_private") {
    return {
      ...common,
      messageMode: requiredEnum(registration, "messageMode", STANDARD_MESSAGE_MODES, INPUT_ERROR_CODE),
      toolAllowlist: requireToolAllowlist(registration.toolAllowlist, type),
      type,
    };
  }
  return {
    ...common,
    messageMode: requiredEnum(registration, "messageMode", EXTERNAL_MESSAGE_MODES, INPUT_ERROR_CODE),
    toolAllowlist: requireToolAllowlist(registration.toolAllowlist, type),
    type,
  };
}

export function requireManageTelegramGroupInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_telegram_group", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_telegram_group", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_telegram_group", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // MiniMax may materialize published siblings from another action. Each branch consumes only its
  // complete contract, while the global guard rejects every unpublished field before HITL.
  if (action === "status") return { action } as const;
  if (action === "start_new_context") {
    return { action, telegramChatId: requireContextRotationGroupId(payload.telegramChatId) } as const;
  }
  if (action === "remove") {
    return {
      action,
      telegramChatId: requireTelegramGroupId(payload.telegramChatId, "telegramChatId"),
    } as const;
  }
  if (action === "update_policy") {
    return {
      action,
      policy: {
        messageMode: requiredEnum(payload, "messageMode", EXTERNAL_MESSAGE_MODES, INPUT_ERROR_CODE),
        telegramChatId: requireTelegramGroupId(payload.telegramChatId, "telegramChatId"),
        toolAllowlist: requireExternalToolAllowlist(payload.toolAllowlist, "action=update_policy"),
      },
    } as const;
  }
  if (action === "update_skills") {
    return {
      action,
      skillAllowlist: requireSkillAllowlist(payload.skillAllowlist),
      telegramChatId: requireTelegramGroupId(payload.telegramChatId, "telegramChatId"),
    } as const;
  }
  return { action, registration: requireRegistration(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Show the status of the family's Telegram groups, request a new context for all topics of a chosen group, register a trust zone, replace the tool/skill policy or delete a registration and its data.",
  "First choose one action and fill only its fields; never guess telegramChatId. On the /status command or a request to show group settings call exactly {\"action\":\"status\"}: it needs no confirmation and returns type, messageMode, the full toolAllowlist and skillAllowlist, the base workspace tools and a ready startNewContextInput for each group.",
  "A repeated register with another type re-creates the trust zone and irreversibly deletes its history, workspace, memory and sessions; for an ordinary change of permissions always use update_policy.",
  "Remove does not call Telegram leaveChat: the bot stays a member of the chat. Update_policy and start_new_context delete nothing: the group, its history, workspace, memory and files are kept, and start_new_context only starts a new canonical generation from the next message.",
  "If the owner asks to turn one permission on or off, first call status and carry the unchanged current permissions into the full toolAllowlist; add or remove only the chosen capability. The same rule applies to update_skills: it replaces the whole list, and an empty array revokes all skills.",
  "Available only to the owner in a private chat; do not accept familyId or a role from the user's text.",
  "web_search, web_fetch, get_current_time, todo, agent and the base file tools are always available in external groups; do not include them in the editable toolAllowlist and do not promise to disable them.",
  "In private and family chats all installed skills are always available. An external group gets only the saved skillAllowlist, including the family's skills. Enabling a skill that needs Bash also saves the bash permission and turns on the public network in the group's isolated environment; revoking bash disables the dependent skills. Changing permissions stops the group's current processes but does not delete its files.",
  "For an external group messageMode=owner_only keeps the shared timeline but allows starting the model only for the current Osinara owner; the owner's Telegram admin rights do not replace this.",
  "Register passes a nested registration object, other actions only flat fields. Update_policy contains exactly action, telegramChatId, messageMode and the full toolAllowlist; do not pass type and title: {\"action\":\"register\",\"registration\":{\"type\":\"external\",\"telegramChatId\":\"-1001234567890\",\"title\":\"Внешняя группа\",\"messageMode\":\"owner_only\",\"toolAllowlist\":[\"search_memories\"]}} and {\"action\":\"update_policy\",\"telegramChatId\":\"-1001234567890\",\"messageMode\":\"all\",\"toolAllowlist\":[\"search_memories\"]}.",
  "After an input error, fix the payload according to the error text and retry no more than once; on a repeated error stop and clarify the data.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = requireManageTelegramGroupInput(toolInput);
    return parsed.action === "status" || parsed.action === "start_new_context"
      ? "not-applicable"
      : "user-approval";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageTelegramGroupSchema,
  async execute(input, ctx) {
    const parsed = requireManageTelegramGroupInput(input);
    const owner = requirePrivateTelegramOwner(ctx);

    if (parsed.action === "status") {
      const groups = await telegramGroupAdministrationRepository.listStatuses({
        familyId: owner.familyId,
        requestedBy: owner.userId,
      });
      const catalog = skillGrantCatalog(await familySkillRepository.grantableSkills(owner.familyId));
      const skillNames = grantableSkillNames(catalog);
      const workingSkills = skillNames.filter((name) => isWorkingSkill(catalog, name));
      return {
        availableSafeSkills: skillNames,
        skillRequirements: Object.fromEntries(skillNames.map((name) => [name, {
          tools: skillNeedsBash(catalog, name) ? ["bash"] : [],
          ...(isWorkingSkill(catalog, name) ? {} : { disabledFamilySkill: true }),
          ...(name.startsWith("gws-") || name === "t-invest" ? { connectionRequired: true, externalConnectionAvailable: false } : {}),
        }])),
        groups: groups.map((group) => {
          if (group.type === "family_private") {
            return {
              ...group,
              effectiveSkills: workingSkills,
              builtInWorkspaceTools: [],
              effectiveConfiguredTools: [],
              policySummary:
                "Инструменты назначаются семейным режимом; отдельный allowlist не настраивается.",
              toolAccessMode: "family_policy" as const,
              startNewContextInput: {
                action: "start_new_context" as const,
                telegramChatId: group.telegramChatId,
              },
            };
          }
          const builtInWorkspaceTools = [...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES];
          // A grant persisted under a previous model provider stays in PostgreSQL but is inert, so
          // status reports the round-trippable allowlist and names the dead grants separately.
          const { effective, unavailable } = selectGrantableExternalGroupTools(group.toolAllowlist);
          // A disabled family skill stays in the stored list but is inert until it is enabled again.
          const inactiveSkills = group.skillAllowlist.filter((name) => !workingSkills.includes(name));
          return {
            ...group,
            builtInWorkspaceTools,
            alwaysAvailableTools: [...builtInWorkspaceTools, ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name), "agent"],
            effectiveConfiguredTools: [...new Set([...builtInWorkspaceTools, ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name), "agent", ...effective])],
            effectiveSkills: group.skillAllowlist.filter((name) => workingSkills.includes(name)),
            ...(inactiveSkills.length === 0 ? {} : { inactiveConfiguredSkills: inactiveSkills }),
            policySummary: unavailable.length === 0
              ? "Базовые workspace tools плюс полный настроенный allowlist внешней группы."
              : "Базовые workspace tools плюс действующий allowlist внешней группы; " +
                "перечисленные unavailableConfiguredTools сейчас не действуют и не могут быть " +
                "выданы заново в текущей конфигурации агента.",
            startNewContextInput: {
              action: "start_new_context" as const,
              telegramChatId: group.telegramChatId,
            },
            toolAccessMode: "external_allowlist" as const,
            toolAllowlist: effective,
            ...(unavailable.length === 0 ? {} : { unavailableConfiguredTools: unavailable }),
          };
        }),
        total: groups.length,
      };
    }
    if (parsed.action === "start_new_context") {
      const { telegramChatId } = parsed;
      const result = await telegramGroupAdministrationRepository.requestGroupSessionRotation({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        telegramChatId,
      });
      return {
        groupId: result.groupId,
        newContextStartsWithNextMessage: true,
        pendingTasksPreserved: true,
        requestedCanonicalSessions: result.requestedCanonicalSessions,
        scope: "all_topics" as const,
        telegramChatId,
      };
    }
    if (parsed.action === "update_policy") {
      const { messageMode, telegramChatId, toolAllowlist } = parsed.policy;
      const result = await telegramGroupAdministrationRepository.updatePolicy({
        familyId: owner.familyId,
        messageMode,
        requestedBy: owner.userId,
        telegramChatId,
        toolAllowlist,
      });
      return {
        botMembership: "unchanged",
        groupId: result.groupId,
        messageMode,
        policyUpdated: true,
        telegramChatId,
        toolAllowlist,
      };
    }
    if (parsed.action === "update_skills") {
      const { skillAllowlist, telegramChatId } = parsed;
      const result = await telegramGroupAdministrationRepository.updateSkills({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        skillAllowlist,
        telegramChatId,
      });
      return {
        groupId: result.groupId,
        skillAllowlist,
        skillsUpdated: true,
        ...(result.skillsNeedBash ? { automaticallyEnabledTools: ["bash"], publicInternetEnabled: true } : {}),
        takesEffect: "next_group_turn" as const,
        telegramChatId,
      };
    }
    if (parsed.action === "remove") {
      const { telegramChatId } = parsed;
      const result = await telegramGroupAdministrationRepository.removeRegistration({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        telegramChatId,
      });
      return {
        botMembership: "unchanged",
        groupId: result.groupId,
        registrationRemoved: true,
        telegramChatId,
      };
    }

    const { registration } = parsed;
    const result = await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      familyId: owner.familyId,
      requestedBy: owner.userId,
    });
    return {
      active: true,
      groupId: result.groupId,
      messageMode: registration.messageMode,
      telegramChatId: registration.telegramChatId,
      title: registration.title,
      toolAllowlist: registration.toolAllowlist,
      type: registration.type,
    };
  },
});
