/**
 * Exact-process Google Workspace CLI runner.
 *
 * Exports:
 * - `createGoogleWorkspaceCommandRunner`: injectable exact-process boundary.
 * - `runGoogleWorkspaceCommand`: delegates exact argv to isolated one-shot runner compute.
 *
 * The child receives one reviewed argv array, one workspace cwd, and one credential profile. There
 * are no retries; timeout, output bounds, and non-zero exits become stable Russian application errors.
 */
import type { ToolContext } from "../../runtime/tool.js";

import {
  GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS,
  SANDBOX_RUNNER_BASE_URL,
} from "../../config.js";
import { ModelFacingError } from "../model-facing-error.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";

export interface GoogleWorkspaceCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);
const MODEL_DIAGNOSTIC_MAX_CHARACTERS = 1_000;
const REDACTED_DIAGNOSTIC_VALUE = "[СКРЫТО]";

type GoogleWorkspaceCommandKind = "mutation" | "read";

interface GoogleWorkspaceCommandRunnerDependencies {
  run(
    request: Parameters<SandboxRunnerClient["runGoogleWorkspace"]>[0],
    signal?: AbortSignal,
  ): ReturnType<SandboxRunnerClient["runGoogleWorkspace"]>;
}

function redactDiagnosticSecrets(value: string, accessToken: string): string {
  // The exact live token is always sensitive even when its provider format changes.
  return value
    .split(accessToken).join(REDACTED_DIAGNOSTIC_VALUE)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      `$1=${REDACTED_DIAGNOSTIC_VALUE}`,
    )
    .replace(/\b(Bearer|Basic)\s+[^\s]+/giu, `$1 ${REDACTED_DIAGNOSTIC_VALUE}`)
    .replace(/:\/\/([^\s:/]+):([^\s@/]+)@/gu, `://$1:${REDACTED_DIAGNOSTIC_VALUE}@`);
}

function boundedDiagnostic(stderr: string, accessToken: string): string | null {
  const normalized = redactDiagnosticSecrets(stderr, accessToken).replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, MODEL_DIAGNOSTIC_MAX_CHARACTERS);
}

export function createGoogleWorkspaceCommandRunner(
  dependencies: GoogleWorkspaceCommandRunnerDependencies,
) {
  return async function executeGoogleWorkspaceCommand(
    argv: readonly string[],
    kind: GoogleWorkspaceCommandKind,
    auth: GoogleIntegrationAuthorization,
    accessToken: string,
    ctx: Pick<ToolContext, "abortSignal">,
  ): Promise<GoogleWorkspaceCommandResult> {
    // A credentialed command must never reach the runner with an invented or empty token.
    if (!accessToken) {
      throw new ModelFacingError({
        category: "authorization",
        code: "AGENT_GOOGLE_WORKSPACE_ACCESS_TOKEN_INVALID",
        correction: "Не повторяйте команду. Подключите Google Workspace заново и отправьте новый запрос.",
        reason: "Не удалось получить обязательный токен доступа Google Workspace.",
        retryable: false,
        sideEffectStatus: "not_started",
      });
    }
    let result;
    try {
      result = await dependencies.run({
        accessToken,
        argv: [...argv],
        timeoutMs: GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS,
        workspaceId: auth.workspaceId,
      }, ctx.abortSignal);
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_FAILED",
        error: boundedDiagnostic(error instanceof Error ? error.message : String(error), accessToken),
        kind,
      }));
      if (ctx.abortSignal.aborted) {
        throw new ModelFacingError({
          category: "operation",
          code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_CANCELLED",
          correction: "Не повторяйте команду автоматически. Выполните её снова только по новому запросу пользователя.",
          reason: "Выполнение команды Google Workspace отменено.",
          retryable: false,
          sideEffectStatus: kind === "mutation" ? "unknown" : "not_started",
        });
      }
      throw new ModelFacingError({
        category: "dependency",
        code: kind === "mutation"
          ? "AGENT_GOOGLE_WORKSPACE_EXECUTION_AMBIGUOUS"
          : "AGENT_GOOGLE_WORKSPACE_EXECUTION_FAILED",
        correction: kind === "mutation"
          ? "Не повторяйте mutation. Сначала отдельной read-командой проверьте фактическое состояние Google Workspace."
          : "Повторите read-команду один раз; при повторном сбое сообщите пользователю.",
        reason: kind === "mutation"
          ? "Связь с runner оборвалась после начала mutation; внешнее действие могло выполниться."
          : "Read-команда не была выполнена из-за сбоя связи с runner.",
        retryable: kind === "read",
        sideEffectStatus: kind === "mutation" ? "unknown" : "not_started",
      });
    }
    const diagnostic = boundedDiagnostic(result.stderr, accessToken);
    if (result.exitCode === 0) {
      return { ...result, stderr: diagnostic ?? "" };
    }

    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
      exitCode: result.exitCode,
      stderr: diagnostic,
    }));
    if (result.exitCode === 124 || result.exitCode === 137) {
      throw new ModelFacingError({
        category: "dependency",
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_TIMEOUT",
        correction: kind === "mutation"
          ? "Не повторяйте mutation. Сначала отдельной read-командой проверьте фактическое состояние."
          : "Сузьте период, фильтр или размер страницы и повторите read-команду один раз.",
        reason: "Команда Google Workspace не завершилась за отведённое время.",
        retryable: kind === "read",
        sideEffectStatus: kind === "mutation" ? "unknown" : "not_started",
      });
    }
    throw new ModelFacingError({
      category: "input",
      code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
      correction: kind === "mutation"
        ? "Не повторяйте mutation автоматически. Проверьте фактическое состояние read-командой, затем исправьте payload по schema."
        : "Исправьте параметры по gws schema и повторите read-команду один раз.",
      reason: diagnostic === null
        ? "Google Workspace отклонил команду без дополнительной диагностики."
        : `Google Workspace отклонил команду: ${diagnostic}`,
      retryable: kind === "read",
      sideEffectStatus: kind === "mutation" ? "unknown" : "not_started",
    });
  };
}

export const runGoogleWorkspaceCommand = createGoogleWorkspaceCommandRunner({
  run: (request, signal) => runner.runGoogleWorkspace(request, signal),
});
