/**
 * Russian user-facing Telegram interface helpers.
 *
 * Exports:
 * - `localizeTelegramInputRequest`: translates approvals without changing response IDs.
 * - `localizeTelegramReplyMarkup`: translates the freeform answer placeholder.
 * - Failure formatters: hide internals while preserving stable support references.
 */

const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  remember: "сохранить запись в общей или чувствительной памяти",
  remove_group_file: "удалить файл внешней группы",
};

const MANAGED_ACTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  manage_behavior_preference: {
    reset: "сбросить настройку поведения агента",
  },
  manage_family_invitation: {
    approve: "добавить участника в семью",
    create: "создать приглашение в семейного агента",
  },
  manage_memory: {
    delete: "удалить запись из памяти",
    edit: "исправить запись в памяти",
  },
  manage_reminder: {
    create: "создать напоминание",
    delete: "удалить напоминание",
    pause: "приостановить напоминание",
    resume: "возобновить напоминание",
    update: "изменить напоминание",
  },
  manage_task: {
    complete: "завершить задачу",
    create: "создать задачу",
    delete: "удалить задачу",
    update: "изменить задачу",
  },
  manage_telegram_group: {
    register: "подключить Telegram-группу",
    remove: "отключить Telegram-группу и удалить её данные",
  },
  notification_settings: {
    set: "изменить настройки уведомлений",
  },
};

const ERROR_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

interface TelegramInputOption {
  description?: string;
  id: string;
  label: string;
  style?: "danger" | "default" | "primary";
}

interface TelegramInputRequest {
  action: {
    callId: string;
    input: Record<string, unknown>;
    kind: "tool-call";
    toolName: string;
  };
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  options?: TelegramInputOption[];
  prompt: string;
  requestId: string;
}

interface FailureData {
  code: string;
  details?: Readonly<Record<string, unknown>>;
}

function approvalParameterLines(toolName: string, input: Record<string, unknown>): string[] {
  // Render only reviewed, user-understandable fields; unknown tool payloads remain hidden.
  const value = (key: string): string | null => {
    const candidate = input[key];
    return typeof candidate === "string" && candidate ? candidate : null;
  };
  const line = (label: string, key: string): string[] => {
    const candidate = value(key);
    return candidate ? [`${label}: ${candidate}`] : [];
  };

  switch (toolName) {
    case "manage_telegram_group": {
      if (input.action === "remove") return line("Telegram chat ID", "telegramChatId");
      const registration = input.registration;
      if (!registration || typeof registration !== "object") return [];
      const values = registration as Record<string, unknown>;
      const allowlist = Array.isArray(values.toolAllowlist)
        ? values.toolAllowlist.filter((item): item is string => typeof item === "string").join(", ")
        : "";
      const registrationLine = (label: string, key: string): string[] => {
        const candidate = values[key];
        return typeof candidate === "string" && candidate ? [`${label}: ${candidate}`] : [];
      };
      return [
        ...registrationLine("Название", "title"),
        ...registrationLine("Telegram chat ID", "telegramChatId"),
        ...registrationLine("Тип группы", "type"),
        ...registrationLine("Режим сообщений", "messageMode"),
        ...(allowlist ? [`Разрешённые инструменты: ${allowlist}`] : []),
      ];
    }
    case "manage_family_invitation":
      if (input.action === "create") return [];
      return [
        ...line("Кандидат", "candidateDisplayName"),
        ...line("Telegram user ID", "candidateTelegramUserId"),
      ];
    case "manage_memory":
      return input.action === "edit"
        ? [...line("ID записи", "id"), ...line("Новое значение", "content")]
        : line("ID записи", "id");
    case "remember":
      return [
        ...line("Область", "scope"),
        ...line("Содержимое", "content"),
        ...line("Чувствительность", "sensitivity"),
      ];
    case "manage_behavior_preference":
      return [...line("Настройка", "preference"), ...line("Область", "scope")];
    case "manage_task":
    case "manage_reminder":
      return [...line("ID", "id"), ...line("Название", "title"), ...line("Текст", "content")];
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

function supportReference(details: FailureData["details"]): string | null {
  if (!details) return null;
  return ERROR_ID_PATTERN.exec(JSON.stringify(details))?.[0] ?? null;
}

export function localizeTelegramInputRequest<T extends TelegramInputRequest>(request: T): T {
  if (request.display !== "confirmation") return request;

  // Option IDs remain unchanged because Eve resolves callbacks by ID, not visible text.
  const options = request.options?.map((option) => ({
    ...option,
    label:
      option.id === "approve"
        ? "Да, выполнить"
        : option.id === "deny"
          ? "Нет, отменить"
          : option.label,
  }));
  const actionLabel = approvalActionLabel(request.action.toolName, request.action.input);
  const parameterLines = approvalParameterLines(request.action.toolName, request.action.input);
  const prompt = actionLabel
    ? `Подтвердите действие: ${actionLabel}.`
    : "Подтвердите выполнение действия.";
  return {
    ...request,
    ...(options ? { options } : {}),
    prompt: parameterLines.length ? `${prompt}\n\n${parameterLines.join("\n")}` : prompt,
  };
}

export function localizeTelegramReplyMarkup(
  replyMarkup: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (replyMarkup?.force_reply !== true) return replyMarkup;
  return { ...replyMarkup, input_field_placeholder: "Введите ответ" };
}

export function formatTelegramTurnFailure(data: FailureData): string {
  const errorId = supportReference(data.details);
  return [
    "Не удалось выполнить запрос.",
    "Попробуйте отправить сообщение ещё раз. Если ошибка повторится, сообщите код поддержке.",
    `Код: ${data.code}`,
    ...(errorId ? [`Номер ошибки: ${errorId}`] : []),
  ].join("\n\n");
}

export function formatTelegramSessionFailure(data: FailureData): string {
  const errorId = supportReference(data.details);
  return [
    "Не удалось продолжить этот диалог после ошибки.",
    "Отправьте новое сообщение, чтобы продолжить работу.",
    `Код: ${data.code}`,
    ...(errorId ? [`Номер ошибки: ${errorId}`] : []),
  ].join("\n\n");
}
