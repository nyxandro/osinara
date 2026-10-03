import { readFile } from "node:fs/promises";

import { streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { buildModeToolSurface } from "../../lib/tool-policy/mode-tool-surface.js";
import { defineTool, type ToolDefinition } from "../tool.js";
import * as builtIns from "../tools/defaults.js";
import { unpackReferenceFile, type ReferenceFile } from "../testing/model-request-reference.js";
import { BUILT_IN_TOOL_ORDER, orderStepTools, toModelToolSet } from "./model-tools.js";

type ProviderTool = { name: string };

async function recordedTools(scenario: string): Promise<ProviderTool[]> {
  const file = JSON.parse(await readFile(`agent/runtime/testing/reference-requests/${scenario}.json`, "utf8")) as ReferenceFile;
  return (unpackReferenceFile(file)[0]!.request as { tools: ProviderTool[] }).tools;
}

async function providerTools(tools: ReturnType<typeof toModelToolSet>): Promise<ProviderTool[]> {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([{
        type: "finish",
        finishReason: { raw: undefined, unified: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      }]),
    }),
  });
  await streamText({ model, prompt: "x", tools }).consumeStream();
  return model.doStreamCalls[0]!.tools as ProviderTool[];
}

function plain(name: string, inputSchema: ToolDefinition["inputSchema"] = z.object({})): ToolDefinition {
  return defineTool({ description: `${name} tool`, inputSchema, execute: () => name } as ToolDefinition);
}

describe("step tool order", () => {
  it("puts the built-in tools first in Eve's order, then the static tools, then agent, then the rest as given", () => {
    const tools = Object.fromEntries(["remember", "agent", "todo", "glob", "bash", "ask_question", "probe_workspace", "get_current_time"]
      .map((name) => [name, plain(name)]));

    expect(orderStepTools(tools, ["probe_workspace"]).map(([name]) => name))
      .toEqual(["ask_question", "bash", "todo", "probe_workspace", "agent", "remember", "glob", "get_current_time"]);
  });

  it("keeps the recorded order of every scenario's tool set", async () => {
    for (const scenario of ["private-first", "family-group", "external-human", "scheduled-isolated"]) {
      const recorded = (await recordedTools(scenario)).map((tool) => tool.name);
      const shuffled = Object.fromEntries([...recorded].reverse().map((name) => [name, plain(name)]));
      const surfaceOrder = recorded.filter((name) => !(BUILT_IN_TOOL_ORDER as readonly string[]).includes(name) &&
        name !== "probe_workspace" && name !== "agent");
      const asSurface = Object.fromEntries([...Object.entries(shuffled).filter(([name]) => !surfaceOrder.includes(name)),
        ...surfaceOrder.map((name) => [name, shuffled[name]!] as const)]);

      expect(orderStepTools(asSurface, ["probe_workspace"]).map(([name]) => name), scenario).toEqual(recorded);
    }
  });
});

// Changed on purpose after Eve's requests were recorded (stage 7, family skills): a new tool, and a
// group skill list that also names the family's own skills.
const CHANGED_AFTER_RECORDING = new Set(["manage_skill", "manage_telegram_group"]);

describe("model-facing tool definitions", () => {
  it("reach the model exactly as Eve sent the application tools of a private chat", async () => {
    const surface = buildModeToolSurface({ environment: "private", scheduledRun: false }) as Record<string, ToolDefinition>;
    const recorded = new Map((await recordedTools("private-first")).map((tool) => [tool.name, tool]));
    // Built-in tools move into the runtime in stage 4; their definitions are compared there.
    const application = Object.fromEntries(Object.entries(surface).filter(([name]) =>
      !(BUILT_IN_TOOL_ORDER as readonly string[]).includes(name) && !["agent", "glob", "grep"].includes(name)));

    const sent = await providerTools(toModelToolSet(orderStepTools(application)));

    expect(sent.length).toBeGreaterThan(30);
    expect(sent.map((tool) => tool.name)).toEqual(expect.arrayContaining([...CHANGED_AFTER_RECORDING]));
    for (const tool of sent.filter((candidate) => !CHANGED_AFTER_RECORDING.has(candidate.name))) {
      expect(JSON.stringify(tool), tool.name).toBe(JSON.stringify(recorded.get(tool.name)));
    }
  });

  it("reach the model exactly as Eve sent its built-in tools", async () => {
    const recorded = new Map((await recordedTools("private-first")).map((tool) => [tool.name, tool]));
    const tools = {
      ask_question: builtIns.askQuestion, bash: builtIns.bash, glob: builtIns.glob, grep: builtIns.grep,
      load_skill: builtIns.loadSkill, read_file: builtIns.readFile, todo: builtIns.todo, write_file: builtIns.writeFile,
    };

    const sent = await providerTools(toModelToolSet(orderStepTools(tools)));

    expect(sent.map((tool) => tool.name)).toEqual(["ask_question", "bash", "read_file", "write_file", "todo", "load_skill", "glob", "grep"]);
    for (const tool of sent) expect(JSON.stringify(tool), tool.name).toBe(JSON.stringify(recorded.get(tool.name)));
  });

  it("accept a plain JSON schema as well as a zod schema", async () => {
    const sent = await providerTools(toModelToolSet([["raw", plain("raw", { type: "object", properties: { a: { type: "string" } } })]]));

    expect(sent).toEqual([{ type: "function", name: "raw", inputSchema: { type: "object", properties: { a: { type: "string" } } }, description: "raw tool" }]);
  });
});
