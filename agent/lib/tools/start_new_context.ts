/**
 * Manual durable session rotation tool.
 *
 * Export:
 * - Eve `start_new_context` tool that rotates before the next ordinary user turn.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { applicationSessionId } from "../sessions/session-context.js";
import { sessionRepository } from "../sessions/session-repository.js";

export default defineTool({
  description:
    "Начать новый чистый контекст разговора по явной просьбе пользователя. Долговременная память, напоминания и файлы сохраняются.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await sessionRepository.requestRotation(applicationSessionId(ctx));
    return {
      message: "Новый контекст начнётся со следующего сообщения.",
      rotationRequested: true,
    };
  },
});
