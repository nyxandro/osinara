/**
 * Manual durable session rotation tool.
 *
 * Export:
 * - Eve `start_new_context` tool that rotates before the next ordinary user turn.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { applicationSessionId } from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";

export default defineTool({
  description:
    "Начать новый чистый контекст разговора по явной просьбе пользователя. Долговременная память, задачи и файлы сохраняются.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await sessionRepository.requestRotation(applicationSessionId(ctx));
    return {
      message: "Новый контекст начнётся со следующего сообщения.",
      rotationRequested: true,
    };
  },
});
