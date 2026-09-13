/**
 * Google Workspace argv and policy error contracts.
 *
 * Exports:
 * - `validateGoogleWorkspaceArgv`: rejects empty, oversized, and NUL-containing argv.
 * - `googleWorkspaceCommandForbidden`: structured correctable allowlist rejection.
 * - `googleWorkspaceArgumentsTooLarge`: stable HITL presentation-size rejection.
 */
import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_LENGTH = 64 * 1024;

export function googleWorkspaceCommandForbidden(
  reason = "Команда или route отсутствует в проверенном allowlist.",
  correction = "Сверьте trusted skill и передайте API resource и method отдельными аргументами; этот отказ не означает, что OAuth-профиль доступен только для чтения.",
  example?: Readonly<Record<string, unknown>>,
): AppError {
  return new ModelFacingError({
    category: "input",
    code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN",
    correction,
    reason,
    retryable: true,
    sideEffectStatus: "not_started",
    ...(example ? { example } : {}),
  });
}

export function googleWorkspaceArgumentsTooLarge(): AppError {
  return new AppError(
    "AGENT_GOOGLE_WORKSPACE_ARGUMENTS_TOO_LARGE",
    "Параметры изменения Google Workspace слишком велики для полного показа перед подтверждением",
  );
}

export function validateGoogleWorkspaceArgv(argv: readonly string[]): void {
  if (argv.length === 0) {
    throw googleWorkspaceCommandForbidden(
      "argv пуст.",
      "Передайте непустой argv без имени бинарника gws.",
    );
  }
  if (argv.length > MAX_ARGUMENT_COUNT) {
    throw googleWorkspaceCommandForbidden(
      "argv содержит слишком много элементов.",
      `Сократите argv до ${MAX_ARGUMENT_COUNT} элементов.`,
    );
  }
  for (const argument of argv) {
    if (!argument) {
      throw googleWorkspaceCommandForbidden(
        "argv содержит пустой аргумент.",
        "Удалите пустой элемент и повторите вызов один раз.",
      );
    }
    if (argument.length > MAX_ARGUMENT_LENGTH) {
      throw googleWorkspaceCommandForbidden(
        "Один аргумент превышает допустимый размер.",
        "Сократите JSON payload или фильтр.",
      );
    }
    if (argument.includes("\0")) {
      throw googleWorkspaceCommandForbidden(
        "argv содержит запрещённый NUL.",
        "Удалите NUL из аргумента.",
      );
    }
  }
}
