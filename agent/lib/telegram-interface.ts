/**
 * Russian user-facing Telegram interface helpers.
 *
 * Exports:
 * - `localizeTelegramInputRequest`: translates approvals without changing response IDs.
 * - `localizeTelegramReplyMarkup`: translates the freeform answer placeholder.
 * - `TelegramInputRequest`: stable structural input used by the secure HITL renderer.
 */
import {
  buildApprovalMessage,
  genericApprovalFacts,
} from "./telegram-hitl/approval-message.js";


const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  remove_group_file: "удалить файл внешней группы",
};

const MANAGED_ACTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  manage_google_workspace_connection: {
    disconnect: "отключить Google Workspace от текущей области",
  },
  manage_family_invitation: {
    approve: "добавить участника в семью",
    create: "создать приглашение в семейного агента",
  },
  manage_telegram_group: {
    register:
      "подключить Telegram-группу. Если чат уже подключён с другим типом, его история, workspace, память и сессии будут безвозвратно удалены",
    remove:
      "удалить регистрацию Telegram-группы и связанные данные Osinara. Бот останется участником Telegram-чата",
    update_policy:
      "изменить политику внешней Telegram-группы. Группа и бот останутся подключены",
    update_skills: "изменить список skills внешней Telegram-группы",
  },
};

interface TelegramInputOption {
  description?: string;
  id: string;
  label: string;
  style?: "danger" | "default" | "primary";
}

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

export interface TelegramInputRequest {
  action: {
    callId: string;
    input: Record<string, TelegramJsonValue>;
    kind: "tool-call";
    toolName: string;
  };
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  /** Framework-owned source of the request. Only `tool-approval` is an application confirmation. */
  kind?: "question" | "tool-approval";
  options?: TelegramInputOption[];
  prompt: string;
  requestId: string;
}

// A tool approval offers `approve` and `cancel`. No path emits `deny`, so no branch for it is kept.
const OPTION_LABELS: Readonly<Record<string, string>> = {
  approve: "Да, подтвердить",
  cancel: "Нет, отменить",
};

function approvalParameterLines(toolName: string, input: Record<string, unknown>): string[] {
  // Render only reviewed, user-understandable fields; unknown tool payloads remain hidden.
  const safe = (candidate: string): string => JSON.stringify(candidate).slice(1, -1);
  const value = (key: string): string | null => {
    const candidate = input[key];
    return typeof candidate === "string" && candidate ? safe(candidate) : null;
  };
  const line = (label: string, key: string): string[] => {
    const candidate = value(key);
    return candidate ? [`${label}: ${candidate}`] : [];
  };
  switch (toolName) {
    case "manage_telegram_group": {
      if (input.action === "remove") return line("Telegram chat ID", "telegramChatId");
      if (input.action === "update_skills") {
        const allowlist = Array.isArray(input.skillAllowlist)
          ? input.skillAllowlist.filter((item): item is string => typeof item === "string").join(", ")
          : null;
        return [
          ...line("Telegram chat ID", "telegramChatId"),
          ...(allowlist === null
            ? []
            : [`Полный список разрешённых skills: ${allowlist || "пуст"}`]),
        ];
      }
      if (input.action === "update_policy") {
        // An empty array is still a complete replacement and must be visible before approval.
        const allowlist = Array.isArray(input.toolAllowlist)
          ? input.toolAllowlist.filter((item): item is string => typeof item === "string").join(", ")
          : null;
        return [
          ...line("Telegram chat ID", "telegramChatId"),
          ...line("Режим сообщений", "messageMode"),
          ...(allowlist !== null
            ? [`Полный список разрешённых инструментов: ${allowlist || "пуст"}`]
            : []),
        ];
      }
      const registration = input.registration;
      if (!registration || typeof registration !== "object") return [];
      const values = registration as Record<string, unknown>;
      const rawAllowlist = values.toolAllowlist;
      const hasAllowlist = Array.isArray(rawAllowlist);
      const allowlist = Array.isArray(rawAllowlist)
        ? rawAllowlist.filter((item): item is string => typeof item === "string").join(", ")
        : "";
      const registrationLine = (label: string, key: string): string[] => {
        const candidate = values[key];
        return typeof candidate === "string" && candidate ? [`${label}: ${safe(candidate)}`] : [];
      };
      return [
        ...registrationLine("Название", "title"),
        ...registrationLine("Telegram chat ID", "telegramChatId"),
        ...registrationLine("Тип группы", "type"),
        ...registrationLine("Режим сообщений", "messageMode"),
        ...(hasAllowlist ? [`Разрешённые инструменты: ${allowlist || "пуст"}`] : []),
      ];
    }
    case "manage_family_invitation":
      if (input.action === "create") return [];
      return [
        ...line("Кандидат", "candidateDisplayName"),
        ...line("Telegram user ID", "candidateTelegramUserId"),
      ];
    case "remove_group_file":
      return line("Путь", "path");
    default:
      return [];
  }
}

function approvalActionLabel(toolName: string, input: Record<string, unknown>): string | null {
  const direct = TOOL_ACTION_LABELS[toolName];
  if (direct) return direct;
  const action = input.action;
  return typeof action === "string" ? MANAGED_ACTION_LABELS[toolName]?.[action] ?? null : null;
}

export function localizeTelegramInputRequest<T extends TelegramInputRequest>(request: T): T {
  // Option IDs remain unchanged because the runtime resolves callbacks by ID, not visible text.
  const options = request.options?.map((option) => ({
    ...option,
    label: OPTION_LABELS[option.id] ?? option.label,
  }));

  // Only an application tool approval gets the composed confirmation; a question keeps its own prompt.
  if (request.display !== "confirmation" || request.kind !== "tool-approval") {
    return options ? { ...request, options } : request;
  }

  const actionLabel = approvalActionLabel(request.action.toolName, request.action.input);
  const reviewed = approvalParameterLines(request.action.toolName, request.action.input);
  return {
    ...request,
    ...(options ? { options } : {}),
    prompt: buildApprovalMessage({
      actionLabel,
      // A reviewed tool that shows no parameters chose that deliberately. Only a tool with no
      // description at all falls back to bounded scalar fields instead of an empty confirmation.
      facts: reviewed.length || actionLabel !== null
        ? reviewed
        : genericApprovalFacts(request.action.input),
    }),
  };
}

export function localizeTelegramReplyMarkup(
  replyMarkup: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (replyMarkup?.force_reply !== true) return replyMarkup;
  return { ...replyMarkup, input_field_placeholder: "Введите ответ" };
}
