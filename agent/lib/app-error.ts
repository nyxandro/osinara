/**
 * Application error contract.
 *
 * Exports:
 * - `AppError`: stable code plus safe Russian user message.
 * - `isAppError`: narrows errors at channel and HTTP boundaries.
 *
 * Key construct:
 * - `isRetryable` is the flag Eve's model-call classifier looks for while walking the cause chain.
 *   Only a failure whose repetition can plausibly succeed may set it.
 * - `details` is log-only diagnostic context; it never reaches the model or the user.
 * - `isExpectedRefusal` marks an answer from the outside world, such as a site that refused a page,
 *   which the tool boundary records without Eve's stack even though its category is `operation`.
 */
export class AppError extends Error {
  readonly code: string;

  readonly isRetryable: boolean;

  readonly isExpectedRefusal: boolean;

  readonly details?: Readonly<Record<string, string | number>>;

  constructor(code: string, message: string, options?: {
    readonly details?: Readonly<Record<string, string | number>>;
    readonly isExpectedRefusal?: boolean;
    readonly isRetryable?: boolean;
  }) {
    super(`${code}: ${message}`);
    this.name = "AppError";
    this.code = code;
    this.isRetryable = options?.isRetryable === true;
    this.isExpectedRefusal = options?.isExpectedRefusal === true;
    if (options?.details !== undefined) this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
