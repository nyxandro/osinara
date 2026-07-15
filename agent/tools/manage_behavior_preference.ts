/**
 * Consolidated behavior preference mutation tool.
 *
 * Export:
 * - `manage_behavior_preference`: sets or resets typed presentation preferences.
 *
 * Key constructs:
 * - Object-shaped model schema keeps Eve tool descriptors transport-safe.
 * - Existing domain schemas remain the source of truth for preference/value pairs.
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
import {
  requireAction,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID";
const TOOL_ACTIONS = ["set", "reset"] as const;
const TOP_LEVEL_FIELDS = ["action", "preference", "scope", "value"] as const;

const manageBehaviorPreferenceSchema = z.object({
  action: z.string().optional(),
  preference: z.string().optional(),
  scope: z.string().optional(),
  value: z.string().optional(),
}).passthrough();

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "preference", "scope", "value"], "action=set", INPUT_ERROR_CODE);
  const parsed = behaviorPreferenceInputSchema.safeParse(input);
  if (!parsed.success) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=set передайте scope, preference и допустимый value. Примеры: tone=warm, language=russian, response_length=concise, answer_structure=structured, status_updates=minimal",
    );
  }
  return parsed.data;
}

function requireResetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "preference", "scope"], "action=reset", INPUT_ERROR_CODE);
  const parsed = behaviorPreferenceResetInputSchema.safeParse(input);
  if (!parsed.success) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=reset передайте scope и preference: answer_structure | language | response_length | status_updates | tone",
    );
  }
  return parsed.data;
}

const TOOL_DESCRIPTION = [
  "Установить или сбросить типизированную настройку представления ответа: длину, тон, язык, структуру или промежуточные статусы.",
  "Set payload: {\"action\":\"set\",\"scope\":\"personal\",\"preference\":\"tone\",\"value\":\"warm\"}.",
  "Reset payload: {\"action\":\"reset\",\"scope\":\"personal\",\"preference\":\"tone\"}. Shared scope family/group требует owner.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "reset" ? "user-approval" : "not-applicable",
  description: TOOL_DESCRIPTION,
  inputSchema: manageBehaviorPreferenceSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_behavior_preference", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_behavior_preference", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_behavior_preference", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const authorization = requireMemoryAuthorization(ctx);

    if (action === "set") {
      const values = requireSetInput(payload);
      const scope = requireWritableScope(authorization, values.scope);
      if (scope !== "personal") requireOwner(ctx);
      return await behaviorPreferenceRepository.set(authorization, {
        preference: values.preference,
        scope,
        value: values.value,
      });
    }

    const values = requireResetInput(payload);
    const scope = requireWritableScope(authorization, values.scope);
    if (scope !== "personal") requireOwner(ctx);
    return {
      deleted: await behaviorPreferenceRepository.delete(
        authorization,
        scope,
        values.preference,
      ),
    };
  },
});
