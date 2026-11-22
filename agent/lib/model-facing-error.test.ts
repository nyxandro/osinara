/**
 * Model-facing tool error contract tests.
 *
 * Constructs covered:
 * - `ModelFacingError`: stable structured remediation visible to the model.
 * - `normalizeModelFacingError`: safe conversion of unexpected dependency failures.
 * - `isExpectedRefusal`: coded refusals are expected, dependency failures are not.
 * - A sandbox out of process room is named, with how to free it, wherever its code sits (#529).
 */
import { describe, expect, it } from "vitest";

import { AppError } from "./app-error.js";
import {
  ModelFacingError,
  normalizeModelFacingError,
} from "./model-facing-error.js";

describe("ModelFacingError", () => {
  it("publishes every required correction-loop field in its model-visible message", () => {
    const error = new ModelFacingError({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      correction: "Передайте непустой query.",
      example: { query: "семейная поездка" },
      field: "query",
      reason: "Поле query отсутствует.",
      retryable: true,
      sideEffectStatus: "not_started",
    });

    expect(error.contract).toEqual({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      correction: "Передайте непустой query.",
      example: { query: "семейная поездка" },
      field: "query",
      reason: "Поле query отсутствует.",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect(error.message).toContain('"sideEffectStatus":"not_started"');
    expect(error.message).toContain('"retryable":true');
  });

  it("preserves an application error code but never exposes an unknown raw failure", () => {
    const known = normalizeModelFacingError(
      new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена"),
      { toolName: "manage_memory" },
    );
    const unknown = normalizeModelFacingError(
      new Error("connect ECONNREFUSED 10.0.0.4:5432"),
      { toolName: "manage_memory" },
    );

    expect(known.contract.code).toBe("AGENT_MEMORY_NOT_FOUND");
    // The list is an action of the memory tool since #457: the hint must not send the model to a removed tool.
    expect(known.contract.correction).toContain("search_memories");
    expect(known.contract.correction).toContain("action=list");
    expect(known.contract.correction).not.toMatch(/list_memories/u);
    expect(unknown.contract.code).toBe("AGENT_TOOL_DEPENDENCY_FAILED");
    expect(unknown.message).not.toContain("10.0.0.4");
    expect(unknown.contract.sideEffectStatus).toBe("unknown");
  });

  // 01.11 and 02.11.2026 a group removal failed twice and nothing kept the reason (#464).
  it("keeps the raw failure as the cause, for the log only", () => {
    const raw = new Error("connect ECONNREFUSED 10.0.0.4:5432");

    const normalized = normalizeModelFacingError(raw, { toolName: "manage_telegram_group" });

    expect(normalized.cause).toBe(raw);
    expect(normalized.message).not.toContain("10.0.0.4");
  });

  it("marks bad-input, not-found, access and conflict refusals as expected", () => {
    const normalize = (error: Error) => normalizeModelFacingError(error, { toolName: "remember" });

    expect(normalize(new AppError("AGENT_MEMORY_SUBJECT_REF_INVALID", "Ссылка недоступна")).isExpectedRefusal)
      .toBe(true);
    expect(normalize(new AppError("AGENT_MEMORY_NOT_FOUND", "Нет записи")).isExpectedRefusal).toBe(true);
    expect(normalize(new AppError("AGENT_GROUP_TOOL_FORBIDDEN", "Нет доступа")).isExpectedRefusal).toBe(true);
    expect(normalize(new AppError("AGENT_MEMORY_THREAD_STALE", "Нить изменилась")).isExpectedRefusal).toBe(true);
  });

  // 21.11.2026 editing another person's memory record was reported to the model as a failure with an
  // unknown outcome, although the server refused before touching anything.
  it("treats a refusal to touch someone else's record, or an action not allowed here, as lack of rights", () => {
    for (const code of [
      "AGENT_MEMORY_MUTATION_DENIED",
      "AGENT_REMINDER_MUTATION_DENIED",
      "AGENT_SCHEDULE_MUTATION_DENIED",
      "AGENT_MEMORY_UNDO_DENIED",
      "AGENT_BACKGROUND_TASK_NOT_ALLOWED",
    ]) {
      const normalized = normalizeModelFacingError(new AppError(code, "Изменить может только автор"), {
        toolName: "manage_memory",
      });

      expect(normalized.contract).toMatchObject({
        category: "authorization", code, retryable: false, sideEffectStatus: "not_started",
      });
      expect(normalized.isExpectedRefusal).toBe(true);
    }
  });

  it("keeps an internal sandbox failure loud although its code also ends in DENIED", () => {
    const normalized = normalizeModelFacingError(
      new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable"),
      { toolName: "bash" },
    );

    expect(normalized.contract.category).toBe("dependency");
    expect(normalized.isExpectedRefusal).toBe(false);
  });

  it("keeps operation and dependency failures loud unless the thrower marks a refusal", () => {
    const normalize = (error: Error) => normalizeModelFacingError(error, { toolName: "manage_memory_thread" });

    // `operation` is the fallback category, so a broken integration lands there too.
    expect(normalize(new AppError("AGENT_MEMORY_EMBEDDING_MODEL_MISMATCH", "Модель другая")).isExpectedRefusal)
      .toBe(false);
    expect(normalize(new AppError("AGENT_DATABASE_UNAVAILABLE", "База недоступна")).isExpectedRefusal)
      .toBe(false);
    expect(normalize(new Error("connect ECONNREFUSED")).isExpectedRefusal).toBe(false);
    expect(new ModelFacingError({
      category: "dependency", code: "AGENT_WEB_SEARCH_RATE_LIMITED", correction: "Продолжите без поиска.",
      reason: "Лимит поиска исчерпан.", retryable: false, sideEffectStatus: "not_started",
    }).isExpectedRefusal).toBe(false);
    // A site that said no is an answer, not a failure of the application.
    expect(normalize(new AppError("AGENT_WEB_FETCH_RESPONSE_FAILED", "HTTP 403", { isExpectedRefusal: true }))
      .isExpectedRefusal).toBe(true);
  });

  it("preserves a generic AGENT code without exposing its untrusted message suffix", () => {
    const normalized = normalizeModelFacingError(
      new Error("AGENT_FAKE_PROVIDER_FAILED: /srv/private/token"),
      { toolName: "external_dependency" },
    );

    expect(normalized.contract.code).toBe("AGENT_FAKE_PROVIDER_FAILED");
    expect(normalized.contract.reason).not.toContain("/srv/private/token");
    expect(normalized.message).not.toContain("/srv/private/token");
  });

  it("tells the model a full sandbox is freed by closing its browsers, wherever the runner's code sits (#529)", () => {
    for (const [toolName, error] of [
      // A file operation the runner refused: the code leads the message.
      ["send_file", new Error("AGENT_SANDBOX_PROCESS_LIMIT_REACHED: The sandbox has no room for new processes. (HTTP 503)")],
      // glob and grep quote the command's stderr, where the runner appended its line.
      ["glob", new Error("glob failed (exit 125): timeout: fork system call failed: Resource temporarily unavailable\n" +
        "AGENT_SANDBOX_PROCESS_LIMIT_REACHED: The sandbox has no room for new processes.\nCommand: find /workspace/personal -name x")],
    ] as const) {
      const normalized = normalizeModelFacingError(error, { toolName });
      expect(normalized.contract).toMatchObject({
        category: "dependency", code: "AGENT_SANDBOX_PROCESS_LIMIT_REACHED", retryable: true, sideEffectStatus: "not_started",
      });
      expect(normalized.contract.correction).toMatch(/agent-browser session list.*agent-browser --session <имя> close/u);
      expect(normalized.message).not.toContain("/workspace/personal");
      // Still a failure for the log: a sandbox that keeps filling up must show in the error burst.
      expect(normalized.isExpectedRefusal).toBe(false);
    }
    // Text that only mentions the code inside a line is someone else's words, not the runner's line.
    const quoted = normalizeModelFacingError(
      new Error("cp failed: cannot stat 'AGENT_SANDBOX_PROCESS_LIMIT_REACHED: x'"), { toolName: "send_file" },
    );
    expect(quoted.contract.code).not.toBe("AGENT_SANDBOX_PROCESS_LIMIT_REACHED");
  });
});
