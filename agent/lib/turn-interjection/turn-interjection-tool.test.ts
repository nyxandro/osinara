/**
 * Turn interjection tool wrapper tests.
 *
 * Constructs covered:
 * - Without waiting messages a wrapped tool returns and projects exactly what it did before.
 * - A waiting message travels with the result and reaches the model after the tool's own output.
 * - A custom model projection of the tool is preserved, including file parts.
 * - A failed tool never consults the queue, and a failed lookup never fails the tool.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withTurnInterjection } from "./turn-interjection-tool.js";

const BLOCK = '<messages_while_working marker="m1">\n{"messages":[]}\n</messages_while_working>';
const CONTEXT = { callId: "call-1" } as never;

type AnyTool = ToolDefinition<any, any>;

function interjection(collect: () => Promise<string | null>) {
  return { collect, release: async () => undefined };
}

function tool(execute: () => unknown, toModelOutput?: (output: any) => unknown): AnyTool {
  return defineTool({
    description: "Тестовый инструмент",
    execute: execute as never,
    inputSchema: z.object({}),
    ...(toModelOutput ? { toModelOutput: toModelOutput as never } : {}),
  }) as AnyTool;
}

async function run(definition: AnyTool) {
  const output = await definition.execute({}, CONTEXT);
  return { model: await definition.toModelOutput!(output), output };
}

afterEach(() => vi.restoreAllMocks());

describe("withTurnInterjection", () => {
  it("keeps the result and its projection unchanged when nothing waits", async () => {
    const wrapped = withTurnInterjection(tool(() => ({ exitCode: 0, stdout: "ok" })), interjection(async () => null));
    expect(await run(wrapped)).toEqual({
      model: { type: "json", value: { exitCode: 0, stdout: "ok" } },
      output: { exitCode: 0, stdout: "ok" },
    });

    const text = withTurnInterjection(tool(() => "готово"), interjection(async () => null));
    expect((await run(text)).model).toEqual({ type: "text", value: "готово" });
  });

  it("appends the waiting messages after the tool's own JSON output", async () => {
    const collect = vi.fn(async () => BLOCK);
    const wrapped = withTurnInterjection(tool(() => ({ stdout: "ok" })), interjection(collect));

    const { model } = await run(wrapped);

    expect(collect).toHaveBeenCalledWith(CONTEXT);
    expect(model).toEqual({ type: "text", value: `{"stdout":"ok"}\n\n${BLOCK}` });
  });

  it("recognizes a stored result whose tool returned nothing", async () => {
    const wrapped = withTurnInterjection(tool(() => undefined), interjection(async () => BLOCK));
    const stored = JSON.parse(JSON.stringify(await wrapped.execute({}, CONTEXT)));

    expect(await wrapped.toModelOutput!(stored)).toEqual({ type: "text", value: `null\n\n${BLOCK}` });
  });

  it("keeps a custom projection and its file parts", async () => {
    const parts = [
      { text: "Снимок экрана", type: "text" },
      { data: { data: "aGVsbG8=", type: "data" }, mediaType: "image/png", type: "file" },
    ];
    const wrapped = withTurnInterjection(
      tool(() => ({ path: "shot.png" }), () => ({ type: "content", value: parts })),
      interjection(async () => BLOCK),
    );

    expect((await run(wrapped)).model).toEqual({
      type: "content",
      value: [...parts, { text: BLOCK, type: "text" }],
    });

    const textProjection = withTurnInterjection(
      tool(() => ({ page: 1 }), () => ({ type: "text", value: "Страница 1" })),
      interjection(async () => BLOCK),
    );
    expect((await run(textProjection)).model).toEqual({ type: "text", value: `Страница 1\n\n${BLOCK}` });
  });

  it("passes an Eve sign-in request through untouched", async () => {
    const signal = { __eveAuthorization: true, challenges: [] };
    const collect = vi.fn(async () => BLOCK);
    const wrapped = withTurnInterjection(tool(() => signal), interjection(collect));

    expect(await wrapped.execute({}, CONTEXT)).toBe(signal);
    expect(collect).not.toHaveBeenCalled();
  });

  it("does not consult the queue when the tool itself fails, and frees an earlier attempt's claims", async () => {
    const collect = vi.fn(async () => BLOCK);
    const release = vi.fn(async () => undefined);
    const wrapped = withTurnInterjection(tool(() => { throw new Error("boom"); }), { collect, release });

    await expect(wrapped.execute({}, CONTEXT)).rejects.toThrow("boom");
    expect(collect).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(CONTEXT);
  });

  it("returns the tool result when the lookup fails and logs the failure once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wrapped = withTurnInterjection(tool(() => ({ stdout: "ok" })), interjection(async () => {
      throw new Error("database unavailable");
    }));

    expect(await run(wrapped)).toEqual({
      model: { type: "json", value: { stdout: "ok" } },
      output: { stdout: "ok" },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ code: "AGENT_TURN_INTERJECTION_FAILED" });
  });
});
