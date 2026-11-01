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
  it("puts the built-in tools first in the reference order, then the static tools, then agent, then the rest as given", () => {
    const tools = Object.fromEntries(["remember", "agent", "todo", "glob", "bash", "probe_workspace", "get_current_time"]
      .map((name) => [name, plain(name)]));

    expect(orderStepTools(tools, ["probe_workspace"]).map(([name]) => name))
      .toEqual(["bash", "todo", "probe_workspace", "agent", "remember", "glob", "get_current_time"]);
  });

  it("keeps the recorded order of every scenario's tool set", async () => {
    for (const scenario of ["private-first", "family-group", "external-human", "scheduled-isolated"]) {
      const recorded = (await recordedTools(scenario)).map((tool) => tool.name).filter((name) => !REMOVED_AFTER_RECORDING.has(name));
      const shuffled = Object.fromEntries([...recorded].reverse().map((name) => [name, plain(name)]));
      const surfaceOrder = recorded.filter((name) => !(BUILT_IN_TOOL_ORDER as readonly string[]).includes(name) &&
        name !== "probe_workspace" && name !== "agent");
      const asSurface = Object.fromEntries([...Object.entries(shuffled).filter(([name]) => !surfaceOrder.includes(name)),
        ...surfaceOrder.map((name) => [name, shuffled[name]!] as const)]);

      expect(orderStepTools(asSurface, ["probe_workspace"]).map(([name]) => name), scenario).toEqual(recorded);
    }
  });
});

// Changed on purpose after the reference requests were recorded (stage 7, family skills): a new tool, and a
// group skill list that also names the family's own skills. Owner-approved network access added its tool
// on 20.10.2026; on 26.10.2026 monitors added the check of `manage_agent_schedule`, and reply buttons
// written in a reminder's `content` changed `manage_reminder`. On 28.10.2026 Google Workspace changes
// stopped waiting for the owner's button, except those that open data to others, and scenario runs
// started only reading Google. On 29–31.10.2026 rare procedures moved into service skills: these
// descriptions say which skill to load, keep the call contract and drop rules stated elsewhere. On
// 01.11.2026 the agent learnt to send a place and a poll, and the owner got `manage_api_keys` for
// API keys that skills in sandboxes use without seeing them.
const CHANGED_AFTER_RECORDING = new Set([
  "execute_google_workspace", "export_memory", "manage_agent_schedule", "manage_api_keys", "manage_behavior_preference",
  "manage_external_group_schedule", "manage_family_invitation", "manage_gmail_message",
  "manage_google_workspace_connection", "manage_network_access", "manage_profile_projection", "manage_reminder",
  "manage_skill", "manage_telegram_group", "notification_settings", "search_memories", "send_location", "send_poll",
  "send_voice_message", "web_search",
]);
// The built-in `ask_question` left on 26.10.2026: buttons under the answer replaced it.
const REMOVED_AFTER_RECORDING = new Set(["ask_question"]);

describe("model-facing tool definitions", () => {
  it("reach the model exactly as the reference requests carry the application tools of a private chat", async () => {
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

  it("reach the model exactly as the reference requests carry the built-in tools", async () => {
    const recorded = new Map((await recordedTools("private-first")).map((tool) => [tool.name, tool]));
    const tools = {
      bash: builtIns.bash, glob: builtIns.glob, grep: builtIns.grep,
      load_skill: builtIns.loadSkill, read_file: builtIns.readFile, todo: builtIns.todo, write_file: builtIns.writeFile,
    };

    const sent = await providerTools(toModelToolSet(orderStepTools(tools)));

    expect(sent.map((tool) => tool.name)).toEqual(["bash", "read_file", "write_file", "todo", "load_skill", "glob", "grep"]);
    for (const tool of sent) expect(JSON.stringify(tool), tool.name).toBe(JSON.stringify(recorded.get(tool.name)));
  });

  it("accept a plain JSON schema as well as a zod schema", async () => {
    const sent = await providerTools(toModelToolSet([["raw", plain("raw", { type: "object", properties: { a: { type: "string" } } })]]));

    expect(sent).toEqual([{ type: "function", name: "raw", inputSchema: { type: "object", properties: { a: { type: "string" } } }, description: "raw tool" }]);
  });
});
