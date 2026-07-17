/**
 * Turn-scoped conversation environment instructions.
 *
 * Export:
 * - Eve dynamic instructions selected from current verified Telegram session auth.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  conversationEnvironmentInstructions,
  resolveConversationEnvironment,
} from "../lib/conversation-environment.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      // Fixed profile text preserves a stable prompt prefix and never interpolates auth data.
      const environment = resolveConversationEnvironment(ctx.session.auth);
      return defineInstructions({
        markdown: conversationEnvironmentInstructions(environment),
      });
    },
  },
});
