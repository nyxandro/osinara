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
  kind: z.literal("current_author").describe(
    "The fact concerns the author of the source message: the sourceSequence message, or the current message without it",
  ),
}).strict();
const labelSubjectSchema = z.object({
  kind: z.literal("label").describe(
    "A text topic, or a person who is not the author of the source message, without a verified identity",
  ),
  label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX_CHARACTERS).describe("A short neutral label of the topic"),
}).strict();
const noneSubjectSchema = z.object({ kind: z.literal("none").describe("The record is not about a person") }).strict();

export const memorySubjectSchema = z.discriminatedUnion("kind", [
  currentAuthorSubjectSchema,
  z.object({
    kind: z.literal("verified_ref").describe("The fact concerns a verified subjectRef from the context"),
    subjectRef: z.string().regex(MEMORY_SUBJECT_REF_PATTERN).describe("An opaque subjectRef only from the current profile context"),
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
    action: z.literal("attach").describe("Attach the record to an existing thread"),
    role: threadRoleSchema.describe("The role of the new record inside the thread"),
    threadRef: z.string().regex(THREAD_REF_PATTERN).describe("An opaque ref from list/search/read_memory_thread"),
  }).strict(),
  z.object({
    action: z.literal("create").describe("Atomically create a thread together with the record"),
    identity: z.enum(["subject", "project"]).optional().describe("Identity only for a root thread"),
    parentThreadRef: z.string().regex(THREAD_REF_PATTERN).optional().describe("The parent thread, only for a subthread"),
    purpose: z.string().trim().min(1).max(THREAD_PURPOSE_MAX_CHARACTERS).describe("The stable purpose of the thread"),
    role: threadRoleSchema.describe("The role of the first record inside the thread"),
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_CHARACTERS).describe("A short stable name of the thread"),
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
  ).describe("The #sequence number of one message of the current review batch"),
};

type RememberScopeField = z.ZodType<"family" | "group" | "personal", "family" | "group" | "personal" | undefined>;

function rememberFields(scope: RememberScopeField, verifiedRefs: boolean) {
  const subject = verifiedRefs ? modelFacingMemorySubjectSchema : modelFacingUnverifiedMemorySubjectSchema;
  return {
    attribute: z.string().trim().min(1).max(MEMORY_ATTRIBUTE_MAX_CHARACTERS).optional().describe(
      "A short name of the subject's property the record is about: \"кофе\", \"место работы\", \"размер обуви\". Not the value of the property and not a retelling of the content. Set it when the property changes over time and a new record cancels the previous one; a new record of the same subject with the same name moves the previous one into history. Do not set a general name like \"еда\": it would remove independent facts from active memory. For a record without a subject (subject.kind=none) the property name applies to the whole memory scope, so it must be especially precise there. Not allowed for kind=episode",
    ),
    basis: z.enum(["agent_inferred", "user_requested"]).describe("agent_inferred: you selected the fact from the message yourself, not a guess; user_requested: the author explicitly asked to save it"),
    distinctFrom: z.array(z.string().regex(MEMORY_REF_PATTERN)).max(MEMORY_NEIGHBOUR_CANDIDATE_LIMIT)
      .optional().describe(
        "Only in response to the AGENT_MEMORY_SIMILAR_RECORD_EXISTS refusal: the memoryRef of the shown close records that you have read and consider different facts. Do not fill it in advance",
      ),
    content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARACTERS).describe("One self-contained specific fact without guesses; keep known dates, the context and the exact URL for a useful link"),
    kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]).describe("profile: stable facts about a person; preference: preferences; episode: a single event or experience; fact: other facts, plans, resources; family_shared: facts shared by the family"),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe(
      "The day the event happened, as YYYY-MM-DD, if it is known from the conversation. Do not compute it from vague words like \"давно\" or \"тем летом\" and do not substitute today's date: if unsure, leave it out entirely",
    ),
    scope: scope.describe("The permitted memory scope of the current trust zone"),
    sensitivity: z.enum(["normal", "sensitive"]).describe("The sensitivity of the fact being saved"),
    sourceSequence: z.string().regex(TIMELINE_SEQUENCE_PATTERN).refine(
      (value) => BigInt(value) <= POSTGRES_BIGINT_MAX,
      "Номер сообщения выходит за допустимые границы",
    ).optional().describe(
      "Only for a group: the #sequence number of one message from the visible delta of the current turn; without the field the source is the current message",
    ),
    subject: subject.describe("Who or what the statement belongs to"),
    thread: memoryThreadSchema.optional().describe("An optional atomic thread create or attach"),
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
