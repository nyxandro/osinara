/**
 * Consolidated behavior preference mutation tool.
 *
 * Export:
 * - `manage_behavior_preference` sets or resets typed presentation preferences.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { behaviorPreferenceRepository } from "../lib/behavior-preference-repository.js";
import {
  behaviorPreferenceInputSchema,
  behaviorPreferenceResetInputSchema,
} from "../lib/behavior-preferences.js";
import { requireOwner } from "../lib/family-context.js";
import { requireMemoryAuthorization, requireWritableScope } from "../lib/memory-context.js";

const manageBehaviorPreferenceSchema = z.union([
  z.object({ action: z.literal("set") }).and(behaviorPreferenceInputSchema),
  z.object({ action: z.literal("reset") }).and(behaviorPreferenceResetInputSchema),
]);

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "reset" ? "user-approval" : "not-applicable",
  description:
    "Установить или сбросить типизированную настройку длины, тона, языка, структуры либо промежуточных статусов.",
  inputSchema: manageBehaviorPreferenceSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    if (scope !== "personal") requireOwner(ctx);

    if (input.action === "set") {
      return await behaviorPreferenceRepository.set(authorization, {
        preference: input.preference,
        scope,
        value: input.value,
      });
    }
    return {
      deleted: await behaviorPreferenceRepository.delete(
        authorization,
        scope,
        input.preference,
      ),
    };
  },
});
