/** Structured Gmail message mutations over one bounded batch with semantic Eve HITL. */
import type { ToolContext } from "eve/tools";
import { defineTool } from "eve/tools";

import {
  GMAIL_MESSAGE_BATCH_MAX,
  gmailMessageInputSchema,
  gmailMessageMutationArgv,
  type GmailMessageInput,
  requireGmailMessageInput,
} from "../google-workspace/gmail-message-contract.js";
import { executeGoogleWorkspace } from "../google-workspace/google-workspace-executor.js";
import { groupApprovalDenial } from "../telegram-hitl/approval-surface.js";

interface GmailMessageManagerDependencies {
  execute(
    input: { argv: string[]; expectedProfileRef: string },
    ctx: ToolContext,
  ): Promise<unknown>;
}

export function createGmailMessageManager(dependencies: GmailMessageManagerDependencies) {
  return async function manageGmailMessage(input: GmailMessageInput, ctx: ToolContext) {
    const parsed = requireGmailMessageInput(input);
    return await dependencies.execute({
      argv: gmailMessageMutationArgv(parsed),
      expectedProfileRef: parsed.profileRef,
    }, ctx);
  };
}

const manageGmailMessage = createGmailMessageManager({ execute: executeGoogleWorkspace });

export default defineTool({
  approval: ({ session, toolInput }) => {
    requireGmailMessageInput(toolInput);
    return groupApprovalDenial({ session }) ?? "user-approval";
  },
  description: [
    "Изменить состояние одного или нескольких точных Gmail-писем одним вызовом: корзина, безвозвратное удаление, восстановление, прочитано или не прочитано.",
    "Когда использовать: только по прямой просьбе пользователя изменить письма, чьи messageId и profileRef уже получены из результата Gmail. Просьба удалить письма без слова «навсегда» означает trash.",
    `Пачка: передай все выбранные письма одним вызовом, до ${GMAIL_MESSAGE_BATCH_MAX} messageId; не вызывай инструмент отдельно для каждого письма. Если писем больше ${GMAIL_MESSAGE_BATCH_MAX}, обработай первые ${GMAIL_MESSAGE_BATCH_MAX} и после результата спроси, продолжать ли со следующей пачкой.`,
    "Не использовать: для чтения и поиска писем.",
    "Вход: action, messageIds и profileRef копируй из результата Gmail без изменений.",
    "Osinara сама загрузит отправителей и темы этих писем и покажет их в одном обязательном подтверждении, сгруппировав по отправителям. Если пользователь сам не просил сначала показать список, не пересказывай его в чате перед вызовом и не спрашивай подтверждение текстом.",
    "Результат: действие выполнено для всей пачки только при completed=true; не повторяй его автоматически.",
  ].join(" "),
  inputSchema: gmailMessageInputSchema,
  async execute(input, ctx) {
    return await manageGmailMessage(input, ctx);
  },
});
