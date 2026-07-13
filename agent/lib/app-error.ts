/**
 * Application error contract.
 *
 * Exports:
 * - `AppError`: stable code plus safe Russian user message.
 * - `isAppError`: narrows errors at channel and HTTP boundaries.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AppError";
    this.code = code;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
