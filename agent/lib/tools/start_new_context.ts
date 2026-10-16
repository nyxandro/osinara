/**
 * Manual durable session rotation tool.
 *
 * Export:
 * - `start_new_context` tool that rotates before the next ordinary user turn.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { applicationSessionId } from "../sessions/session-context.js";
import { sessionRepository } from "../sessions/session-repository.js";

export default defineTool({
  description:
    "Start a new clean conversation context on the user's explicit request. Long-term memory, reminders and files are kept.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await sessionRepository.requestRotation(applicationSessionId(ctx));
    return {
      message: "Новый контекст начнётся со следующего сообщения.",
      rotationRequested: true,
    };
  },
});
