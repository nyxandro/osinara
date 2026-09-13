/**
 * Typed model-facing Google Workspace execution boundary.
 *
 * Exports:
 * - `execute_google_workspace`: reviewed argv execution with input-aware Eve HITL.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { classifyModelFacingGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import {
  executeGoogleWorkspace,
} from "../google-workspace/google-workspace-executor.js";

export { createGoogleWorkspaceExecutor } from "../google-workspace/google-workspace-executor.js";

const commandSchema = z.object({
  argv: z.array(z.string().min(1).max(64 * 1024)).min(1).max(128).describe(
    "Точные аргументы gws без имени бинарника и shell quoting; API resource и method передаются отдельными элементами",
  ),
}).strict();

export default defineTool({
  approval: ({ toolInput }) => {
    try {
      return classifyModelFacingGoogleWorkspaceCommand(toolInput?.argv ?? []) === "mutation"
        ? "user-approval"
        : "not-applicable";
    } catch (error) {
      return {
        type: "denied",
        reason: error instanceof AppError
          ? error.message
          : "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN: Команда отсутствует в allowlist",
      };
    }
  },
  description:
    "Выполнить разрешённую команду Google Workspace в текущем personal/family профиле. Это единственный путь запуска gws; в Bash бинарника и Google-профиля нет. Передайте точный argv без gws. Для непрочитанной почты: [\"gmail\",\"+triage\",\"--max\",\"20\",\"--labels\"]. Для календаря: [\"calendar\",\"+agenda\",\"--today\"] (период и timezone задайте по задаче). Знак + обязателен у helper. API resource и method передавайте отдельными элементами: [\"gmail\",\"users\",\"messages\",\"list\",\"--params\",\"{\\\"userId\\\":\\\"me\\\",\\\"q\\\":\\\"is:unread\\\"}\"]. Справка: [\"schema\",\"gmail.users.messages.list\"] или [\"schema\",\"calendar.events.list\"]. Состояние отдельного Gmail-письма изменяй только через manage_gmail_message, передавая messageId и profileRef из результата чтения без изменений. Mutation автоматически требует подтверждения Eve со всеми аргументами и должна занимать не более 3000 символов в JSON-представлении. Файловые аргументы недоступны.",
  inputSchema: commandSchema,
  async execute(input, ctx) {
    classifyModelFacingGoogleWorkspaceCommand(input.argv);
    return await executeGoogleWorkspace(input, ctx);
  },
});
