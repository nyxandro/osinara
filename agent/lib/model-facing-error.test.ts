/**
 * Model-facing tool error contract tests.
 *
 * Constructs covered:
 * - `ModelFacingError`: stable structured remediation visible to the model.
 * - `normalizeModelFacingError`: safe conversion of unexpected dependency failures.
 * - `isExpectedRefusal`: coded refusals are expected, dependency failures are not.
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
      { toolName: "list_memories" },
    );

    expect(known.contract.code).toBe("AGENT_MEMORY_NOT_FOUND");
    expect(known.contract.correction).toMatch(/list_memories|search_memories/iu);
    expect(unknown.contract.code).toBe("AGENT_TOOL_DEPENDENCY_FAILED");
    expect(unknown.message).not.toContain("10.0.0.4");
    expect(unknown.contract.sideEffectStatus).toBe("unknown");
  });

  it("marks coded refusals as expected and keeps dependency failures unexpected", () => {
    const normalize = (error: Error) => normalizeModelFacingError(error, { toolName: "remember" });

    expect(normalize(new AppError("AGENT_MEMORY_SUBJECT_REF_INVALID", "Ссылка недоступна")).isExpectedRefusal)
      .toBe(true);
    expect(normalize(new AppError("AGENT_WEB_FETCH_RESPONSE_FAILED", "HTTP 403")).isExpectedRefusal).toBe(true);
    expect(normalize(new AppError("AGENT_GROUP_TOOL_FORBIDDEN", "Нет доступа")).isExpectedRefusal).toBe(true);
    // Infrastructure failures and unknown exceptions must stay loud in Eve's own log.
    expect(normalize(new AppError("AGENT_DATABASE_UNAVAILABLE", "База недоступна")).isExpectedRefusal)
      .toBe(false);
    expect(normalize(new Error("connect ECONNREFUSED")).isExpectedRefusal).toBe(false);
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
});
