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
    `Изменить состояние до ${GMAIL_MESSAGE_BATCH_MAX} точных Gmail-писем одним вызовом: корзина, удаление навсегда, восстановление, прочитано или непрочитано.`,
    "Только по прямой просьбе пользователя; messageIds и profileRef копируй без изменений из результата Gmail. «Удали» без слова «навсегда» означает trash.",
    `Все выбранные письма передавай одним вызовом, не по одному; если их больше ${GMAIL_MESSAGE_BATCH_MAX}, обработай первые ${GMAIL_MESSAGE_BATCH_MAX} и спроси, продолжать ли. Не для чтения и поиска.`,
    "Osinara сама покажет отправителей и темы в обязательном подтверждении: не пересказывай список в чате и не спрашивай подтверждение текстом, если пользователь сам не просил показать список.",
    "Выполнено для всей пачки только при completed=true; не повторяй автоматически.",
  ].join(" "),
  inputSchema: gmailMessageInputSchema,
  async execute(input, ctx) {
    return await manageGmailMessage(input, ctx);
  },
});
