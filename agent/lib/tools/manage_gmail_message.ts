/** Structured single-message Gmail mutations with semantic Eve HITL. */
import type { ToolContext } from "eve/tools";
import { defineTool } from "eve/tools";

import {
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
    "Изменить состояние одного точного Gmail-письма: корзина, безвозвратное удаление, восстановление, прочитано или не прочитано.",
    "Когда использовать: только по прямой просьбе пользователя изменить одно письмо, чьи messageId и profileRef уже получены из результата Gmail.",
    "Не использовать: для чтения, поиска, целых цепочек писем или нескольких писем одним вызовом.",
    "Вход: передавай action, messageId и profileRef без изменений; для нескольких писем вызывай инструмент отдельно для каждого.",
    "Перед выполнением Osinara сама загрузит отправителя, тему, дату и короткий фрагмент этого письма и покажет их в обязательном подтверждении.",
    "Результат: действие выполнено только при completed=true; не повторяй его автоматически.",
  ].join(" "),
  inputSchema: gmailMessageInputSchema,
  async execute(input, ctx) {
    return await manageGmailMessage(input, ctx);
  },
});
