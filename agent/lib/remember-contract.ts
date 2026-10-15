/**
 * Shared model-facing `remember` input contract.
 *
 * Exports:
 * - `memorySubjectSchema`: explicit current-author, verified-ref, label, or subjectless intent.
 * - `memoryThreadSchema`: atomic thread create/attach contract.
 * - `createRememberInputSchema`: the contract narrowed to the scopes one surface may write into and,
 *   for a surface without profile views, to subjects that need no verified reference.
 * - `onlyMemoryScope`: the scope field of a surface that may write into exactly one scope.
 * - `createReviewRememberInputSchema`: the silent review's contract: constants filled, source required.
 * - `rememberInputSchema`: trusted personal/family/group tool input.
 * - `externalRememberInputSchema`: exact external-group presentation contract.
 * - `RememberInput`: parsed trusted tool input type.
 *
 * Key constructs:
 * - `modelFacingMemorySubjectSchema`: also accepts a nested subject a provider sent as a JSON string.
 */
import { z } from "zod";

import { MEMORY_ATTRIBUTE_MAX_CHARACTERS } from "./memory-attribute-slot.js";
import { MEMORY_NEIGHBOUR_CANDIDATE_LIMIT } from "./memory-neighbour-gate.js";
import { MEMORY_REF_PATTERN } from "./model-memory.js";
import {
  THREAD_PURPOSE_MAX_CHARACTERS,
  THREAD_TITLE_MAX_CHARACTERS,
} from "./memory-config.js";
import { THREAD_REF_PATTERN } from "./memory-thread-query-repository.js";

const MEMORY_CONTENT_MAX_CHARACTERS = 4_000;
const SUBJECT_LABEL_MAX_CHARACTERS = 200;
const TIMELINE_SEQUENCE_PATTERN = /^[1-9]\d*$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const MEMORY_SUBJECT_REF_PATTERN = /^subj_[0-9a-f]{32}$/u;

const currentAuthorSubjectSchema = z.object({
  kind: z.literal("current_author").describe("Сведение относится к автору текущего сообщения"),
}).strict();
const labelSubjectSchema = z.object({
  kind: z.literal("label").describe("Текстовая тема без проверенной identity"),
  label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX_CHARACTERS).describe("Краткая нейтральная метка темы"),
}).strict();
const noneSubjectSchema = z.object({ kind: z.literal("none").describe("Запись не относится к человеку") }).strict();

export const memorySubjectSchema = z.discriminatedUnion("kind", [
  currentAuthorSubjectSchema,
  z.object({
    kind: z.literal("verified_ref").describe("Сведение относится к проверенному subjectRef из контекста"),
    subjectRef: z.string().regex(MEMORY_SUBJECT_REF_PATTERN).describe("Opaque subjectRef только из текущего profile context"),
  }).strict(),
  labelSubjectSchema,
  noneSubjectSchema,
]);

/** A surface without profile views could never resolve a verified reference, so it is not offered. */
const unverifiedMemorySubjectSchema = z.discriminatedUnion("kind", [
  currentAuthorSubjectSchema,
  labelSubjectSchema,
  noneSubjectSchema,
]);

/*
 * A provider on the OpenAI-compatible transport can send a nested tool argument as a compact JSON
 * string. Such a string is parsed and must then pass the same strict subject schema; malformed JSON
 * stays an ordinary schema failure. The check runs here instead of as a pattern in the schema, which
 * the model would otherwise read with every request.
 */
function modelFacingSubject<T extends typeof memorySubjectSchema | typeof unverifiedMemorySubjectSchema>(schema: T) {
  return z.union([
    schema,
    z.string()
      .transform((value, context) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          context.addIssue({ code: "custom", message: "subject передаётся объектом, например {\"kind\":\"current_author\"}" });
          return z.NEVER;
        }
      })
      .pipe(schema),
  ]);
}

const modelFacingMemorySubjectSchema = modelFacingSubject(memorySubjectSchema);
// The schema the model reads must not name verified_ref on a surface that cannot resolve it.
const modelFacingUnverifiedMemorySubjectSchema = modelFacingSubject(unverifiedMemorySubjectSchema);

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

/**
 * A surface that may write into exactly one scope fills it itself: the model left that one-value
 * field out in 9 of 12 rejected calls (03-15.10.2026). Any other scope is still refused.
 */
export function onlyMemoryScope<const Scope extends "family" | "group" | "personal">(scope: Scope) {
  return z.literal(scope).default(scope);
}

// A silent review writes only normal memory the model itself selected from a named batch message.
// The two constants are filled, and the message number is required where the model can see it.
const REVIEW_INPUT_INVALID =
  "AGENT_MEMORY_REVIEW_INPUT_INVALID: Тихая проверка сохраняет только normal-память, отобранную самой моделью, из сообщения sourceSequence текущего пакета";
const REVIEW_REMEMBER_FIELDS = {
  basis: z.literal("agent_inferred", { error: REVIEW_INPUT_INVALID }).default("agent_inferred"),
  sensitivity: z.literal("normal", { error: REVIEW_INPUT_INVALID }).default("normal"),
  sourceSequence: z.string({ error: REVIEW_INPUT_INVALID }).regex(TIMELINE_SEQUENCE_PATTERN).refine(
    (value) => BigInt(value) <= POSTGRES_BIGINT_MAX,
    "Номер сообщения выходит за допустимые границы",
  ).describe("Номер #sequence одного сообщения текущего пакета проверки"),
};

type RememberScopeField = z.ZodType<"family" | "group" | "personal", "family" | "group" | "personal" | undefined>;

function rememberFields(scope: RememberScopeField, verifiedRefs: boolean) {
  const subject = verifiedRefs ? modelFacingMemorySubjectSchema : modelFacingUnverifiedMemorySubjectSchema;
  return {
    attribute: z.string().trim().min(1).max(MEMORY_ATTRIBUTE_MAX_CHARACTERS).optional().describe(
      "Короткое имя свойства субъекта, о котором запись: «кофе», «место работы», «размер обуви». Не значение свойства и не пересказ содержания. Ставь его, когда свойство со временем меняется и новая запись отменяет прежнюю; новая запись того же субъекта с тем же именем переводит прежнюю в историю. Не ставь общее имя вроде «еда» — оно уберёт из активной памяти независимые сведения. У записи без субъекта (subject.kind=none) имя свойства действует на всю область памяти, поэтому там оно должно быть особенно точным. Для kind=episode поле недопустимо",
    ),
    basis: z.enum(["agent_inferred", "user_requested"]).describe("agent_inferred: сама отобрала сведение из сообщения, не догадка; user_requested: автор прямо попросил сохранить"),
    distinctFrom: z.array(z.string().regex(MEMORY_REF_PATTERN)).max(MEMORY_NEIGHBOUR_CANDIDATE_LIMIT)
      .optional().describe(
        "Только в ответ на отказ AGENT_MEMORY_SIMILAR_RECORD_EXISTS: memoryRef показанных близких записей, которые ты прочитала и считаешь другими сведениями. Не заполняй заранее",
      ),
    content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARACTERS).describe("Одно самостоятельное конкретное сведение без догадок; сохраняй известные даты, контекст и точный URL для полезной ссылки"),
    kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]).describe("profile: устойчивые сведения о человеке; preference: предпочтения; episode: отдельное событие или опыт; fact: прочие факты, планы, ресурсы; family_shared: общесемейные сведения"),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe(
      "День, когда событие произошло, в формате ГГГГ-ММ-ДД, если он известен из разговора. Не вычисляй его из расплывчатых слов вроде «давно» или «тем летом» и не подставляй сегодняшнюю дату: не уверена — не указывай вовсе",
    ),
    scope: scope.describe("Разрешённая область памяти текущего trust zone"),
    sensitivity: z.enum(["normal", "sensitive"]).describe("Чувствительность сохраняемого сведения"),
    sourceSequence: z.string().regex(TIMELINE_SEQUENCE_PATTERN).refine(
      (value) => BigInt(value) <= POSTGRES_BIGINT_MAX,
      "Номер сообщения выходит за допустимые границы",
    ).optional().describe(
      "Только для группы: номер #sequence одного сообщения из видимой дельты текущего хода; без поля источником является текущее сообщение",
    ),
    subject: subject.describe("Кому или чему принадлежит утверждение"),
    thread: memoryThreadSchema.optional().describe("Необязательное атомарное создание нити или attach"),
  };
}

/** What the cross-field checks read; every remember contract variant produces at least this. */
interface RememberCheckInput {
  readonly attribute?: string;
  readonly kind: string;
  readonly scope: string;
  readonly sensitivity: string;
  readonly sourceSequence?: string;
  readonly subject: { readonly kind: string };
  readonly thread?: { readonly action: string; readonly identity?: string };
}

function checkRememberInput(input: RememberCheckInput, context: z.RefinementCtx): void {
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
  if (input.attribute !== undefined && input.kind === "episode") {
    context.addIssue({
      code: "custom",
      message:
        "AGENT_MEMORY_ATTRIBUTE_INVALID: Событие не имеет свойства, которое меняется со временем",
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
}

export function createRememberInputSchema(
  scope: RememberScopeField,
  options: { readonly verifiedRefs: boolean } = { verifiedRefs: true },
) {
  return z.object(rememberFields(scope, options.verifiedRefs)).strict().superRefine(checkRememberInput);
}

/**
 * A silent review run of one scope: no profile views, so no verified references; its scope and the
 * two constants filled; its source message required.
 */
export function createReviewRememberInputSchema(scope: "family" | "group" | "personal") {
  return z.object({ ...rememberFields(onlyMemoryScope(scope), false), ...REVIEW_REMEMBER_FIELDS })
    .strict().superRefine(checkRememberInput);
}

export const rememberInputSchema = createRememberInputSchema(
  z.enum(["personal", "family", "group"]),
);
export const externalRememberInputSchema = createRememberInputSchema(onlyMemoryScope("group"));
export type RememberInput = z.infer<typeof rememberInputSchema>;
