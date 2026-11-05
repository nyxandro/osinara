/**
 * Structured error contract for model-facing tool failures.
 *
 * Exports:
 * - `ModelFacingErrorContract`: correction-loop fields serialized for the model.
 * - `ModelFacingError`: safe application error carrying that complete contract; `isExpectedRefusal`
 *   tells the runtime's tool-failure log (`runtime/turn/tool-calls.ts`) that the tool boundary's
 *   metrics line already recorded the code.
 * - `normalizeModelFacingError`: converts legacy and unexpected failures without leaking internals.
 */
import { AppError } from "./app-error.js";

export type ModelFacingErrorCategory =
  | "authorization"
  | "conflict"
  | "dependency"
  | "input"
  | "not_found"
  | "operation";

export type SideEffectStatus = "completed" | "not_started" | "partial" | "unknown";

export interface ModelFacingErrorContract {
  category: ModelFacingErrorCategory;
  code: string;
  correction: string;
  example?: Readonly<Record<string, unknown>>;
  field?: string;
  reason: string;
  retryable: boolean;
  sideEffectStatus: SideEffectStatus;
}

interface NormalizeModelFacingErrorContext {
  toolName: string;
}

const NOT_FOUND_CORRECTIONS: Readonly<Record<string, string>> = {
  AGENT_MEMORY_NOT_FOUND:
    "Найдите запись через search_memories или manage_memory с action=list и повторите действие только с актуальным memoryRef.",
  AGENT_MEMORY_THREAD_NOT_FOUND:
    "Найдите нить через manage_memory_thread с action=list или action=search и повторите действие только с актуальным threadRef.",
  AGENT_REMINDER_NOT_FOUND:
    "Вызовите manage_reminder с action=list и повторите действие только с актуальным id; если запись уже удалена, прекратите mutation.",
  AGENT_SCHEDULE_NOT_FOUND:
    "Вызовите manage_agent_schedule с action=list и повторите действие только с актуальным id; если запись уже удалена, прекратите mutation.",
  AGENT_WEB_FETCH_HOST_NOT_FOUND:
    "Проверьте написание адреса или найдите правильный через web_search; тот же адрес не повторяйте ни здесь, ни через bash.",
  AGENT_WORKSPACE_FILE_NOT_FOUND:
    "Найдите файл в нужном workspace через glob, а где его нет — через ls в bash, и повторите действие с существующим путём из результата.",
};

function categoryForCode(code: string): ModelFacingErrorCategory {
  if (/(?:INPUT|CURSOR|LIMIT|PATH|REF|FORMAT)_INVALID/u.test(code)) return "input";
  if (code.endsWith("_NOT_FOUND")) return "not_found";
  if (/(?:ACCESS|AUTHORIZATION|FORBIDDEN|OWNER_REQUIRED|SCOPE_DENIED)/u.test(code)) {
    return "authorization";
  }
  if (/(?:CONFLICT|STALE|ALREADY_)/u.test(code)) return "conflict";
  if (/(?:PROVIDER|DEPENDENCY|RUNNER|DATABASE|TIMEOUT)/u.test(code)) return "dependency";
  return "operation";
}

function correctionFor(category: ModelFacingErrorCategory, code: string, toolName: string): string {
  const notFound = NOT_FOUND_CORRECTIONS[code];
  if (notFound) return notFound;
  if (category === "input") {
    return `Исправьте аргументы ${toolName} по его schema и повторите вызов один раз.`;
  }
  if (category === "not_found") {
    return "Получите актуальный идентификатор через соответствующий list/search tool; не придумывайте и не переиспользуйте устаревший ref.";
  }
  if (category === "authorization") {
    return "Не повторяйте вызов и не трактуйте отказ как отсутствие OAuth scope; сообщите, что действие недоступно в текущем контексте.";
  }
  return "Не повторяйте вызов автоматически. Сообщите пользователю о сбое и дождитесь нового запроса.";
}

/**
 * Refusals caused by the call itself: bad arguments, a stale or unknown ref, no access, a conflict.
 * A multi-line stack for them only fed the unstructured-problem alert (#289, #302). `operation`
 * is the fallback category, so a broken integration lands there too: it stays loud unless the
 * thrower marks the refusal explicitly. Dependency failures and unknown exceptions always stay loud.
 */
const EXPECTED_REFUSAL_CATEGORIES: ReadonlySet<ModelFacingErrorCategory> = new Set([
  "authorization", "conflict", "input", "not_found",
]);

export class ModelFacingError extends AppError {
  readonly contract: Readonly<ModelFacingErrorContract>;

  constructor(contract: ModelFacingErrorContract, options?: { readonly cause?: unknown; readonly isExpectedRefusal?: boolean }) {
    // JSON keeps the correction contract machine-readable inside the tool-error text the model reads.
    super(contract.code, JSON.stringify(contract), {
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      isExpectedRefusal: EXPECTED_REFUSAL_CATEGORIES.has(contract.category) || options?.isExpectedRefusal === true,
    });
    this.name = "ModelFacingError";
    this.contract = Object.freeze({ ...contract });
  }
}

export function normalizeModelFacingError(
  error: unknown,
  context: NormalizeModelFacingErrorContext,
): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  const applicationError = error instanceof AppError
    ? { code: error.code, reason: error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "") }
    : null;
  const genericCode = error instanceof Error
    ? /^(AGENT_[A-Z0-9_]+)/u.exec(error.message)?.[1]
    : undefined;
  if (applicationError || genericCode) {
    const code = applicationError?.code ?? genericCode!;
    // Generic errors may carry host paths, addresses, or provider secrets after the stable code.
    const reason = applicationError?.reason ??
      "Инструмент отклонил операцию по проверяемому прикладному правилу.";
    const category = categoryForCode(code);
    const canCorrect = category === "input" || category === "not_found";
    return new ModelFacingError({
      category,
      code,
      correction: correctionFor(category, code, context.toolName),
      reason,
      retryable: canCorrect,
      sideEffectStatus: canCorrect || category === "authorization" ? "not_started" : "unknown",
    }, { isExpectedRefusal: error instanceof AppError && error.isExpectedRefusal });
  }
  // The raw failure stays out of the model's text but travels as the cause, for the log (#464).
  return new ModelFacingError({
    category: "dependency",
    code: "AGENT_TOOL_DEPENDENCY_FAILED",
    correction: "Не повторяйте вызов автоматически. Сообщите пользователю о временном внутреннем сбое.",
    reason: `Зависимость инструмента ${context.toolName} завершилась с ошибкой.`,
    retryable: false,
    sideEffectStatus: "unknown",
  }, { cause: error });
}
