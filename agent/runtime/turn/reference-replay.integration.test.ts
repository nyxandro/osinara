/**
 * The turn loop replays the recorded reference conversations and sends the model the same messages.
 *
 * Each scenario seeds the session with the history the reference had sent before the turn, scripts the model
 * with the answers the reference received, and stubs every tool with the recorded result. The provider
 * request the runtime builds is compared with the reference request after both are normalized the same way. The
 * system prompt is out of scope here (its parts are pinned in `prompt/*.test.ts`), so is the tool
 * JSON (`model-tools.test.ts`).
 */
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../../lib/database.js";
import { unpackReferenceFile, type ReferenceFile } from "../testing/model-request-reference.js";
import type { ToolDefinition } from "../tool.js";
import { callStepModel } from "./model-call.js";
import { runTurn } from "./run-turn.js";
import { respondToInput } from "./turn-start.js";
import { newTestSession, OWNER_AUTH, recordingObserver, startMessageTurn, testAgent, testRuntime } from "./turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const RUN = { abortSignal: new AbortController().signal };
type Prompt = LanguageModelV4CallOptions["prompt"];
type PromptMessage = Prompt[number];

async function rootPrompts(scenario: string): Promise<Prompt[]> {
  const file = JSON.parse(await readFile(new URL(`../testing/reference-requests/${scenario}.json`, import.meta.url), "utf8")) as ReferenceFile;
  return unpackReferenceFile(file).filter((call) => call.agent === "root").map((call) => (call.request as { prompt: Prompt }).prompt);
}

function textOf(message: PromptMessage): string {
  if (message.role !== "user") throw new Error(`TEST_REFERENCE_SHAPE: expected a user message, got ${message.role}`);
  return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

// Before the turn: the history the reference sent; the turn input: the user messages after its last answer.
function splitFirstPrompt(prompt: Prompt) {
  const messages = prompt.slice(1);
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === "user") start -= 1;
  return { history: messages.slice(0, start) as unknown as ModelMessage[], input: messages.slice(start).map(textOf) };
}

// The model's answer at step i is what the next reference request carries after the previous one.
function answers(prompts: readonly Prompt[]) {
  return prompts.slice(1).map((next, index) => {
    const added = next.slice(prompts[index]!.length).filter((message) => message.role === "assistant");
    return added.flatMap((message) => message.role === "assistant" ? message.content : []);
  });
}

function streamFor(parts: ReadonlyArray<Extract<PromptMessage, { role: "assistant" }>["content"][number]>): LanguageModelV4StreamPart[] {
  const stream: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  for (const [index, part] of parts.entries()) {
    if (part.type === "text") stream.push({ type: "text-start", id: `t${index}` }, { type: "text-delta", id: `t${index}`, delta: part.text }, { type: "text-end", id: `t${index}` });
    if (part.type === "tool-call") stream.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.stringify(part.input) });
  }
  const unified = parts.some((part) => part.type === "tool-call") ? "tool-calls" : "stop";
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  stream.push({ type: "finish", finishReason: { raw: undefined, unified }, usage });
  return stream;
}

// Every recorded tool result, by call id, and every tool name the transcript uses.
function recordedResults(prompts: readonly Prompt[]) {
  const results = new Map<string, { output: unknown; toolName: string }>();
  for (const message of prompts.at(-1)!) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-result") results.set(part.toolCallId, { output: part.output, toolName: part.toolName });
  }
  return results;
}

function stubTools(prompts: readonly Prompt[], guarded: ReadonlySet<string>) {
  const results = recordedResults(prompts);
  const tools: Record<string, ToolDefinition<any, any>> = {};
  for (const { toolName } of results.values()) {
    tools[toolName] = {
      ...(guarded.has(toolName) ? { approval: () => "user-approval" as const } : {}),
      description: toolName,
      async execute(_input: unknown, ctx) {
        // A string comes back as a text result, anything else as JSON, as the recording shows.
        return (results.get(ctx.callId)!.output as { value: unknown }).value;
      },
      inputSchema: { type: "object" },
    };
  }
  return tools;
}

// The reference placeholders and the one raw value the runtime adds (a new approval id) are renumbered by
// first appearance, so an id seeded from history and a fresh one stay distinct on both sides.
function renumber(value: unknown): unknown {
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      return item.replace(/<([a-z-]+?)-\d+>|\baitxt-[A-Za-z0-9]{24}\b/gu, (match, label: string | undefined) => {
        const kind = label ?? "aisdk";
        let mapped = seen.get(match);
        if (mapped === undefined) {
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
          mapped = `<${kind}#${counts.get(kind)}>`;
          seen.set(match, mapped);
        }
        return mapped;
      });
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, walk(entry)]));
    }
    return item;
  };
  return walk(value);
}

function comparable(prompt: Prompt) {
  return renumber(prompt.slice(1));
}

async function replay(scenario: string, input: {
  readonly guarded?: readonly string[];
  readonly respond?: { readonly context?: readonly string[]; readonly optionId: string };
  readonly empty?: boolean;
}) {
  const prompts = await rootPrompts(scenario);
  const { history, input: turnInput } = splitFirstPrompt(prompts[0]!);
  const script = answers(prompts);
  const sent: Prompt[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      sent.push(structuredClone(options.prompt));
      const done = [{ type: "text" as const, text: "done" }];
      const step = input.empty === true ? (call === 0 ? [] : done) : script[call] ?? done;
      call += 1;
      return { stream: new ReadableStream({ start(controller) { for (const part of streamFor(step)) controller.enqueue(part); controller.close(); } }) };
    },
  });
  const agent = testAgent(stubTools(prompts, new Set(input.guarded ?? [])), {
    selectModel: () => ({ contextWindowTokens: 1_000_000, model, providerOptions: undefined }),
  });
  const runtime = testRuntime({ agent, callModel: (request) => callStepModel(request), observer: recordingObserver().observer });
  const sessionId = await newTestSession(history);
  const turn = await startMessageTurn(sessionId, turnInput.at(-1)!, turnInput.slice(0, -1));
  const outcome = await runTurn(runtime, turn.id, RUN);
  if (input.respond !== undefined) {
    if (outcome.status !== "waiting_input") throw new Error(`TEST_EXPECTED_PARK: ${outcome.status}`);
    const resumed = await respondToInput(database(), {
      auth: OWNER_AUTH, context: input.respond.context ?? [],
      responses: outcome.requests.map((request) => ({ optionId: input.respond!.optionId, requestId: request.requestId })), sessionId,
    });
    if (resumed.status !== "resumed") throw new Error(`TEST_EXPECTED_RESUME: ${resumed.status}`);
    await runTurn(runtime, resumed.continuation.id, RUN);
  }
  return { prompts, sent };
}

(enabled ? describe : describe.skip)("replay of reference conversations", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("builds every step of a multi-tool turn as the reference did", async () => {
    const { prompts, sent } = await replay("private-first", {});

    expect(sent.map(comparable)).toEqual(prompts.map(comparable));
  });

  it.each([
    ["approval", { guarded: ["manage_profile_projection"], respond: { optionId: "approve" } }],
    ["approval-denied", { guarded: ["manage_profile_projection"], respond: { optionId: "cancel" } }],
    ["question", { respond: { optionId: "continue" } }],
  ] as const)("continues %s exactly as the reference did", async (scenario, input) => {
    const { prompts, sent } = await replay(scenario, input);

    expect(sent.map(comparable)).toEqual(prompts.map(comparable));
  });

  it("puts the approval timeout notice where the reference did", async () => {
    const prompts = await rootPrompts("approval-timeout");
    const notice = textOf(prompts[1]!.at(-3)!);
    const { sent } = await replay("approval-timeout", { guarded: ["manage_profile_projection"], respond: { context: [notice], optionId: "cancel" } });

    expect(sent.map(comparable)).toEqual(prompts.map(comparable));
  });

  it("reissues an empty answer once with the reference notice", async () => {
    const { prompts, sent } = await replay("empty-reply", { empty: true });

    expect(sent.map(comparable)).toEqual(prompts.map(comparable));
  });
});
