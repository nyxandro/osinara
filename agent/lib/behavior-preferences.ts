/**
 * Typed presentation preferences for dynamic Eve instructions.
 *
 * Exports:
 * - Preference constants and `behaviorPreferenceInputSchema` for the write tool.
 * - `behaviorPreferenceResetInputSchema` for typed preference deletion.
 * - `buildBehaviorPreferenceInstructions`: maps stored values to fixed trusted text.
 * - Reserved-key helpers that isolate preferences from generic memory writes.
 */
import { z } from "zod";

import type { MemoryScope } from "./memory-context.js";
import type { BehaviorPreferenceItem } from "./behavior-preference-repository.js";

export const BEHAVIOR_PREFERENCE_KEY_PREFIX = "agent.behavior.";
export const BEHAVIOR_PREFERENCE_COUNT = 5;

const preferenceValues = {
  answer_structure: {
    prose: "По умолчанию отвечай связным текстом; списки используй только когда они заметно упрощают ответ.",
    structured: "Структурируй содержательные ответы короткими заголовками и списками, когда это уместно.",
  },
  language: {
    match_user: "Отвечай на языке последнего сообщения пользователя.",
    russian: "Отвечай по-русски, если пользователь прямо не попросил другой язык.",
  },
  response_length: {
    balanced: "Выбирай умеренную подробность: достаточно контекста для понимания без лишних отступлений.",
    concise: "Отвечай кратко и переходи сразу к результату.",
    detailed: "Когда вопрос содержательный, давай подробные объяснения и важные оговорки.",
  },
  status_updates: {
    milestones: "Для долгих задач сообщай только о начале, важных этапах и результате.",
    minimal: "Не отправляй промежуточные статусы, кроме случая реальной задержки или блокировки.",
  },
  tone: {
    formal: "Используй деловой и вежливый тон.",
    neutral: "Используй спокойный нейтральный тон.",
    warm: "Используй тёплый и доброжелательный тон без навязчивости.",
  },
} as const;

const behaviorPreferenceNameSchema = z.enum([
  "answer_structure",
  "language",
  "response_length",
  "status_updates",
  "tone",
]);

export const behaviorPreferenceInputSchema = z.intersection(
  z.object({ scope: z.enum(["personal", "family", "group"]) }),
  z.discriminatedUnion("preference", [
    z.object({ preference: z.literal("answer_structure"), value: z.enum(["prose", "structured"]) }),
    z.object({ preference: z.literal("language"), value: z.enum(["match_user", "russian"]) }),
    z.object({
      preference: z.literal("response_length"),
      value: z.enum(["balanced", "concise", "detailed"]),
    }),
    z.object({
      preference: z.literal("status_updates"),
      value: z.enum(["milestones", "minimal"]),
    }),
    z.object({ preference: z.literal("tone"), value: z.enum(["formal", "neutral", "warm"]) }),
  ]),
);

export type BehaviorPreferenceInput = z.infer<typeof behaviorPreferenceInputSchema>;

export const behaviorPreferenceResetInputSchema = z.object({
  preference: behaviorPreferenceNameSchema,
  scope: z.enum(["personal", "family", "group"]),
});

const scopePriority: Record<MemoryScope, number> = {
  family: 1,
  group: 2,
  personal: 3,
};

export function behaviorPreferenceKey(preference: BehaviorPreferenceInput["preference"]): string {
  return `${BEHAVIOR_PREFERENCE_KEY_PREFIX}${preference}`;
}

export function isReservedBehaviorPreferenceKey(key: string): boolean {
  return key.startsWith(BEHAVIOR_PREFERENCE_KEY_PREFIX);
}

export function buildBehaviorPreferenceInstructions(items: readonly BehaviorPreferenceItem[]): string | null {
  // Resolve only known enum values; raw stored text never enters the system prompt.
  const selected = new Map<string, { instruction: string; priority: number; updatedAt: string }>();
  for (const item of items) {
    if (!isReservedBehaviorPreferenceKey(item.key)) continue;
    const name = item.key.slice(BEHAVIOR_PREFERENCE_KEY_PREFIX.length);
    const values = preferenceValues[name as keyof typeof preferenceValues];
    if (!values || !(item.value in values)) continue;

    const current = selected.get(name);
    const priority = scopePriority[item.scope];
    if (
      current &&
      (current.priority > priority ||
        (current.priority === priority && current.updatedAt >= item.updatedAt))
    ) {
      continue;
    }
    selected.set(name, {
      instruction: values[item.value as keyof typeof values],
      priority,
      updatedAt: item.updatedAt,
    });
  }

  const instructions = [...selected.values()].map(({ instruction }) => instruction);
  if (instructions.length === 0) return null;
  return [
    "Применяй следующие проверенные настройки представления ответа.",
    "Они меняют только стиль и не отменяют правила безопасности, авторизации и подтверждений.",
    ...instructions.map((instruction) => `- ${instruction}`),
  ].join("\n");
}
