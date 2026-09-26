/**
 * Model-facing tool boundary tests.
 *
 * Constructs covered:
 * - `wrapModelFacingTool`: preserves successful output and normalizes thrown failures.
 * - `wrapModelFacingToolMap`: applies the same boundary to a complete mode surface.
 * - The metrics line carries the failure code and log-only details of a failed call.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";

import { AppError } from "./app-error.js";
import { wrapModelFacingTool, wrapModelFacingToolMap } from "./model-facing-tool.js";

function tool(execute: () => unknown) {
  return defineTool({
    description: "Test tool",
    inputSchema: z.object({}).strict(),
    execute,
  }) as ToolDefinition<any, any>;
}

describe("model-facing tool boundary", () => {
  it("preserves successful outputs and descriptor metadata", async () => {
    const source = tool(() => ({ ok: true }));
    const wrapped = wrapModelFacingTool("test_tool", source);

    await expect(wrapped.execute({}, {} as never)).resolves.toEqual({ ok: true });
    expect(wrapped.description).toContain(source.description);
    // Общий контракт вызова переехал в постоянное ядро, дескриптор несёт только своё назначение.
    expect(wrapped.description).toBe("Test tool");
    expect(wrapped.inputSchema).toBe(source.inputSchema);
  });

  it("normalizes application and raw dependency errors for every mapped tool", async () => {
    const surface = wrapModelFacingToolMap({
      missing: tool(() => {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись не найдена");
      }),
      raw: tool(() => {
        throw new Error("password=secret host=database");
      }),
    });

    await expect(surface.missing!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_MEMORY_NOT_FOUND", retryable: true },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_TOOL_DEPENDENCY_FAILED", retryable: false },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.not.toThrow(/secret/u);
  });

  describe("metrics line", () => {
    afterEach(() => vi.restoreAllMocks());

    function metricsLines(info: MockInstance) {
      return info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    }

    it("records the refusal code and log-only details of a failed call", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const wrapped = wrapModelFacingTool("web_fetch", tool(() => {
        throw new AppError("AGENT_WEB_FETCH_RESPONSE_FAILED", "Сайт не отдал страницу: HTTP 403", {
          details: { origin: "https://example.com", status: 403 },
        });
      }));

      const failure = await wrapped.execute({}, {} as never).catch((error: unknown) => error);

      // Eve no longer prints a stack for a coded refusal, so this line is its only record (#302).
      expect(metricsLines(info)).toEqual([expect.objectContaining({
        code: "AGENT_TOOL_CALL_METRICS",
        errorCode: "AGENT_WEB_FETCH_RESPONSE_FAILED",
        errorDetails: { origin: "https://example.com", status: 403 },
        outcome: "failed",
        toolName: "web_fetch",
      })]);
      expect((failure as Error).message).not.toContain("example.com");
    });

    it("records the fallback code of an unexpected failure and nothing for a success", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      await wrapModelFacingTool("raw", tool(() => {
        throw new Error("password=secret");
      })).execute({}, {} as never).catch(() => undefined);
      await wrapModelFacingTool("ok", tool(() => ({ ok: true }))).execute({}, {} as never);

      const [failed, succeeded] = metricsLines(info);
      expect(failed).toMatchObject({ errorCode: "AGENT_TOOL_DEPENDENCY_FAILED", outcome: "failed" });
      expect(failed).not.toHaveProperty("errorDetails");
      expect(JSON.stringify(failed)).not.toContain("secret");
      expect(succeeded).toMatchObject({ outcome: "succeeded" });
      expect(succeeded).not.toHaveProperty("errorCode");
    });
  });
});
