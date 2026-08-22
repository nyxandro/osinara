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
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../family-context.js";
import type { RegisteredGroupType } from "../family-access.js";
import {
  GROUP_SAFE_SKILL_NAMES,
  isGroupSafeSkillName,
} from "../group-skills/group-skill-catalog.js";
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
} from "../tool-policy/grantable-group-capabilities.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  isSubscriptionOnlyExternalGroupToolName,
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
  messageMode: z.enum(EXTERNAL_MESSAGE_MODES).optional().describe("Обязательно внутри registration: addressed_only, all или owner_only для external."),
  telegramChatId: z.string().optional().describe("Обязательный точный отрицательный Telegram chat ID регистрируемой группы."),
  title: z.string().optional().describe("Обязательное отображаемое название регистрируемой группы."),
  toolAllowlist: z.array(z.enum(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES)).optional().describe("Только для registration.type=external; для family_private поле не передавайте."),
  type: z.enum(GROUP_TYPES).optional().describe("Обязательный тип trust zone: family_private или external."),
}).strict();

const manageTelegramGroupSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe(
    "Сначала выберите ровно один action; обязательные значения: register, remove, start_new_context, status, update_policy или update_skills.",
  ),
  messageMode: z.enum(EXTERNAL_MESSAGE_MODES).optional().describe(
    "Передавайте только при action=update_policy. Для register используйте registration.messageMode; для остальных actions поле не передавайте.",
  ),
  registration: registrationSchema.optional().describe(
    "Передавайте только при action=register. Для остальных actions полностью пропустите registration.",
  ),
  skillAllowlist: z.array(z.enum(GROUP_SAFE_SKILL_NAMES)).optional().describe(
    `Передавайте только при action=update_skills. Полный список: ${GROUP_SAFE_SKILL_NAMES.join(", ")}; пустой массив отзывает все skills.`,
  ),
  telegramChatId: z.string().optional().describe(
    "Точный отрицательный ID обязателен для start_new_context, update_policy, update_skills и remove. Для status не передавайте; для register используйте registration.telegramChatId.",
  ),
  toolAllowlist: z.array(z.enum(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES)).optional().describe(
    "Передавайте на верхнем уровне только при action=update_policy. Для external register используйте registration.toolAllowlist; для остальных actions поле не передавайте.",
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
    // A catalog capability that the active model provider cannot serve gets its own diagnosis, so
    // the owner learns the grant is impossible instead of reading it as a malformed payload.
    if (
      typeof name === "string" &&
      isSubscriptionOnlyExternalGroupToolName(name) &&
      !isGrantableExternalGroupToolName(name)
    ) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Capability ${name} недоступна: текущая модель агента работает не через подписку OpenAI Codex. ` +
          "Выдать это право нельзя; передайте toolAllowlist без него",
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

function requireSkillAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Для action=update_skills передайте skillAllowlist массивом. Доступно: ${GROUP_SAFE_SKILL_NAMES.join(", ")}`,
    );
  }
  const names = raw.map((name) => {
    if (typeof name !== "string" || !isGroupSafeSkillName(name)) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Недопустимый skillAllowlist item. Используйте только: ${GROUP_SAFE_SKILL_NAMES.join(", ")}`,
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

function requireManageTelegramGroupInput(input: unknown) {
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
  "Показать статус Telegram-групп семьи, запросить новый контекст всех тем выбранной группы, зарегистрировать trust zone, заменить tool/skill policy или удалить регистрацию и связанные данные.",
  "Сначала выбери один action и используй только его payload. При команде /status или просьбе показать настройки групп вызови ровно {\"action\":\"status\"}: status не требует подтверждения и возвращает type, messageMode, полные toolAllowlist и skillAllowlist, базовые workspace tools и готовый startNewContextInput для каждой группы.",
  "Некоторые model transports материализуют остальные известные optional-поля общей schema. Tool безопасно игнорирует поля других actions и читает только payload выбранного action; всё равно не заполняй лишние поля и никогда не угадывай telegramChatId.",
  "Повторный register с другим type пересоздаёт trust zone и безвозвратно удаляет её историю, workspace, память и сессии; для обычной смены прав всегда используй update_policy.",
  "Remove не вызывает Telegram leaveChat: бот остаётся участником чата. Самостоятельный выход бота из группы не поддерживается.",
  "Update_policy не отключает группу и сохраняет её ID, название, тип, историю, workspace, память и сессии.",
  "Если владелец просит включить или выключить одно право, сначала вызови status и перенеси неизменённые текущие права в полный toolAllowlist; добавь или удали только выбранную capability.",
  "Start_new_context не удаляет timeline, память, файлы или pending tasks: следующая обычная реплика в main-чате и каждой forum-теме начнёт новую canonical generation.",
  "Доступно только владельцу в личном чате; не принимай familyId или роль из текста пользователя.",
  "Для внешней группы messageMode=owner_only сохраняет общую timeline, но разрешает запуск модели только текущему владельцу Osinara; Telegram admin-права владельца не заменяют.",
  "Enums: action=register | remove | start_new_context | status | update_policy | update_skills; type=family_private | external; messageMode=addressed_only | all | owner_only.",
  "Register payload: {\"action\":\"register\",\"registration\":{\"type\":\"family_private\",\"telegramChatId\":\"-1001234567890\",\"title\":\"Семейный чат\",\"messageMode\":\"addressed_only\"}}.",
  "External register payload: {\"action\":\"register\",\"registration\":{\"type\":\"external\",\"telegramChatId\":\"-1001234567890\",\"title\":\"Внешняя группа\",\"messageMode\":\"owner_only\",\"toolAllowlist\":[\"search_memories\"]}}.",
  "Update_policy payload содержит ровно action, telegramChatId, messageMode и полный toolAllowlist; type и title не передавай: {\"action\":\"update_policy\",\"telegramChatId\":\"-1001234567890\",\"messageMode\":\"all\",\"toolAllowlist\":[\"search_memories\"]}.",
  `Update_skills заменяет полный allowlist безопасных skills и применяется со следующей реплики группы без сброса контекста. Payload: {\"action\":\"update_skills\",\"telegramChatId\":\"-1001234567890\",\"skillAllowlist\":[\"pohuy\"]}. Доступно: ${GROUP_SAFE_SKILL_NAMES.join(", ")}. Для отзыва передай пустой массив.`,
  "Start_new_context payload: {\"action\":\"start_new_context\",\"telegramChatId\":\"-1001234567890\"}.",
  "Remove payload: {\"action\":\"remove\",\"telegramChatId\":\"-1001234567890\"}.",
  "После ошибки входных данных исправь payload по тексту ошибки и повтори не более одного раза; при повторной ошибке остановись и уточни данные.",
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
      return {
        availableSafeSkills: [...GROUP_SAFE_SKILL_NAMES],
        groups: groups.map((group) => {
          if (group.type === "family_private") {
            return {
              ...group,
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
          return {
            ...group,
            builtInWorkspaceTools,
            effectiveConfiguredTools: [...builtInWorkspaceTools, ...effective],
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
