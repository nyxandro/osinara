/**
 * Shared model-facing `remember` input contract.
 *
 * Exports:
 * - `memorySubjectSchema`: explicit current-author, verified-ref, label, or subjectless intent.
 * - `memoryThreadSchema`: atomic thread create/attach contract.
 * - `rememberInputSchema`: trusted personal/family/group tool input.
 * - `externalRememberInputSchema`: exact external-group presentation contract.
 * - `RememberInput`: parsed trusted tool input type.
 *
 * Key constructs:
 * - `modelFacingMemorySubjectSchema`: normalizes the active provider's serialized nested subject.
 */
import { z } from "zod";

import {
  MEMORY_ATTRIBUTE_MAX_CHARACTERS,
  MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
  THREAD_PURPOSE_MAX_CHARACTERS,
  THREAD_TITLE_MAX_CHARACTERS,
} from "./memory-config.js";
import { THREAD_REF_PATTERN } from "./memory-thread-query-repository.js";
import { MEMORY_REF_PATTERN } from "./model-memory.js";

const MEMORY_CONTENT_MAX_CHARACTERS = 4_000;
const SUBJECT_LABEL_MAX_CHARACTERS = 200;
const TIMELINE_SEQUENCE_PATTERN = /^[1-9]\d*$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const MEMORY_SUBJECT_REF_PATTERN = /^subj_[0-9a-f]{32}$/u;

/*
 * The active OpenAI-compatible provider can emit a nested tool argument as a
 * compact JSON string. Match the complete subject grammar before JSON.parse so
 * malformed input remains a normal schema failure and parsing cannot throw.
 */
const JSON_WHITESPACE_PATTERN = String.raw`[ \t\r\n]*`;
const JSON_STRING_PATTERN = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const SERIALIZED_MEMORY_SUBJECT_VARIANTS = [
  String.raw`"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"current_author"`,
  String.raw`"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"none"`,
  String.raw`"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"verified_ref"${JSON_WHITESPACE_PATTERN},${JSON_WHITESPACE_PATTERN}"subjectRef"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}${JSON_STRING_PATTERN}`,
  String.raw`"subjectRef"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}${JSON_STRING_PATTERN}${JSON_WHITESPACE_PATTERN},${JSON_WHITESPACE_PATTERN}"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"verified_ref"`,
  String.raw`"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"label"${JSON_WHITESPACE_PATTERN},${JSON_WHITESPACE_PATTERN}"label"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}${JSON_STRING_PATTERN}`,
  String.raw`"label"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}${JSON_STRING_PATTERN}${JSON_WHITESPACE_PATTERN},${JSON_WHITESPACE_PATTERN}"kind"${JSON_WHITESPACE_PATTERN}:${JSON_WHITESPACE_PATTERN}"label"`,
];
const SERIALIZED_MEMORY_SUBJECT_PATTERN = new RegExp(
  String.raw`^${JSON_WHITESPACE_PATTERN}\{${JSON_WHITESPACE_PATTERN}(?:${SERIALIZED_MEMORY_SUBJECT_VARIANTS.join("|")})${JSON_WHITESPACE_PATTERN}\}${JSON_WHITESPACE_PATTERN}$`,
  "u",
);

export const memorySubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("current_author").describe("Сведение относится к автору текущего сообщения"),
  }).strict(),
  z.object({
    kind: z.literal("verified_ref").describe("Сведение относится к проверенному subjectRef из контекста"),
    subjectRef: z.string().regex(MEMORY_SUBJECT_REF_PATTERN).describe("Opaque subjectRef только из текущего profile context"),
  }).strict(),
  z.object({
    kind: z.literal("label").describe("Текстовая тема без проверенной identity"),
    label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX_CHARACTERS).describe("Краткая нейтральная метка темы"),
  }).strict(),
  z.object({ kind: z.literal("none").describe("Запись не относится к человеку") }).strict(),
]);

const modelFacingMemorySubjectSchema = z.union([
  memorySubjectSchema,
  z.string()
    .regex(SERIALIZED_MEMORY_SUBJECT_PATTERN)
    .transform((value) => JSON.parse(value) as unknown)
    .pipe(memorySubjectSchema),
]);

const threadRoleSchema = z.enum([
  "goal", "constraint", "method", "decision", "episode", "outcome", "lesson", "open_loop",
]);

export const memoryThreadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("attach").describe("Прикрепить запись к существующей нити"),
    role: threadRoleSchema.describe("Роль новой записи внутри нити"),
    threadRef: z.string().regex(THREAD_REF_PATTERN).describe("Opaque ref из list/search/read_memory_thread"),
  }).strict(),
  z.object({
    action: z.literal("create").describe("Атомарно создать нить вместе с записью"),
    identity: z.enum(["subject", "project"]).optional().describe("Identity только для корневой нити"),
    parentThreadRef: z.string().regex(THREAD_REF_PATTERN).optional().describe("Родительская нить только для subthread"),
    purpose: z.string().trim().min(1).max(THREAD_PURPOSE_MAX_CHARACTERS).describe("Устойчивое назначение нити"),
    role: threadRoleSchema.describe("Роль первой записи внутри нити"),
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_CHARACTERS).describe("Краткое устойчивое название нити"),
  }).strict().refine(
    (input) => input.parentThreadRef === undefined || input.identity === undefined,
    { message: "Для subthread identity определяется только проверенной родительской нитью" },
  ),
]);

function createRememberInputSchema(scope: z.ZodType<"family" | "group" | "personal">) {
  return z.object({
    basis: z.enum(["agent_inferred", "user_requested"]).describe("Почему запись сохраняется: устойчивый вывод или явная просьба"),
    attribute: z.string().trim().min(1).max(MEMORY_ATTRIBUTE_MAX_CHARACTERS).optional().describe(
      "Слот записи: для человека работа, профессия, город, семья, дети, партнёр, питомцы, машина, здоровье, привычки, увлечения, вкусы, музыка, еда, техника, прозвище, роль в чате, день рождения; для fact/family_shared о названной сущности или о чате вместе с subject.label (например «Гоша» + «содержание»); для episode только «итог обсуждения» с subject.label = тема. Новая запись в том же слоте заменяет старую",
    ),
    content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARACTERS).describe("Одна самостоятельная устойчивая запись без догадок"),
    distinct: z.boolean().optional().describe("true после AGENT_MEMORY_NEAR_DUPLICATE, если это другой факт, а не версия существующего"),
    reinforces: z.string().regex(MEMORY_REF_PATTERN).optional().describe("После AGENT_MEMORY_NEAR_DUPLICATE: memoryRef записи с тем же смыслом; она подкрепляется, новая не создаётся"),
    kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]).describe("Семантический тип записи"),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/u).refine(
      (value) => Number.isFinite(Date.parse(value)),
      "Дата события должна быть корректной ISO-датой",
    ).optional().describe("Только для episode: дата или дата-время события в ISO 8601, из текста или из sentAt сообщения"),
    scope: scope.describe("Разрешённая область памяти текущего trust zone"),
    sensitivity: z.enum(["normal", "sensitive"]).describe("Sensitive всегда требует Eve HITL"),
    sourceSequence: z.string().regex(TIMELINE_SEQUENCE_PATTERN).refine(
      (value) => BigInt(value) <= POSTGRES_BIGINT_MAX,
      "Номер сообщения выходит за допустимые границы",
    ).optional().describe(
      "Только для группы: номер #sequence одного сообщения из видимой дельты текущего хода; без поля источником является текущее сообщение",
    ),
    subject: modelFacingMemorySubjectSchema.describe("Кому или чему принадлежит утверждение"),
    thread: memoryThreadSchema.optional().describe("Необязательное атомарное создание нити или attach"),
  }).strict().superRefine((input, context) => {
    const create = input.thread?.action === "create" ? input.thread : null;
    if (create?.identity === "project" && input.subject.kind !== "none") {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Project-thread требует subject.kind=none",
        path: ["subject"],
      });
    }
    if (input.subject.kind === "label" && input.thread !== undefined) {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Текстовая метка не задаёт identity нити",
        path: ["subject"],
      });
    }
    if (input.scope === "personal" && create?.identity === "project") {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Project identity недоступна в личной записи",
        path: ["thread", "identity"],
      });
    }
    if (input.occurredAt !== undefined && input.kind !== "episode") {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_INPUT_INVALID: occurredAt применим только к событию",
        path: ["occurredAt"],
      });
    }
    if (input.attribute !== undefined && input.kind === "episode" &&
      input.attribute !== MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE) {
      context.addIssue({
        code: "custom",
        message: `AGENT_MEMORY_INPUT_INVALID: Слот attribute для события допустим только как "${MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE}"`,
        path: ["attribute"],
      });
    }
    if (input.sourceSequence !== undefined && input.sensitivity === "sensitive") {
      context.addIssue({
        code: "custom",
        message:
          "AGENT_MEMORY_INPUT_INVALID: Чувствительное сведение можно сохранить только из текущего сообщения его автора",
        path: ["sourceSequence"],
      });
    }
  });
}

export const rememberInputSchema = createRememberInputSchema(
  z.enum(["personal", "family", "group"]),
);
export const externalRememberInputSchema = createRememberInputSchema(z.literal("group"));
export type RememberInput = z.infer<typeof rememberInputSchema>;
