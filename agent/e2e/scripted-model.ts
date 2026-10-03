/**
 * The model of the application under test: a scripted AI SDK model behind the real model call.
 *
 * Export:
 * - `createScriptedModel`: a `LanguageModelV4` whose answers follow the marker of the turn's
 *   message, `e2e-<n>-<flags>`. The runtime builds the whole request as in production — system
 *   prompt, history, tool definitions — and only the provider is replaced.
 *
 * Flags, in the order the steps happen:
 * - `m`: the message must have woken the agent by an @mention; `x`: by its name in the text, and
 *   the answer is the empty-delivery marker (silence);
 * - `f`: the provider fails;
 * - `p`: one `manage_profile_projection` call that needs the owner's button;
 * - `s`: `load_skill` of `pohuy`; `d`: delegate to a subagent, which answers `child-<marker>`;
 * - every other turn runs one `bash` command; `k` makes it never finish (the process is killed
 *   under it), `h` makes it wait until the test releases the marker;
 * - then the answer `reply-<marker>`; `w` makes it wait until the test releases the marker.
 * Every call is journaled in `e2e_model_calls`.
 *
 * Test-only.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { Pool } from "pg";

import { EMPTY_DELIVERY_MARKER } from "../runtime/turn/step-history.js";
import { E2E_TABLES } from "./e2e-tables.js";

const MARKER_PATTERN = /e2e-\d+-[a-z]*/gu;
const RELEASE_POLL_MILLISECONDS = 100;
const SUBAGENT_OPENING = 'You are the subagent "agent".';
export const E2E_EXTERNAL_CHAT_ID = -900_000_101;

type Prompt = LanguageModelV4Prompt;
type Step = { readonly text: string } | { readonly toolCall: { readonly input: unknown; readonly name: string } };

interface ToolResult {
  readonly output: { readonly type: string; readonly value?: unknown };
  readonly toolName: string;
}

function messageText(message: Prompt[number]): string {
  if (message.role === "system") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

// The turn's message is the last one with a marker: after a button, a context line follows it.
function currentTurn(prompt: Prompt): { readonly results: ToolResult[]; readonly user: string } {
  let lastUser = prompt.length - 1;
  while (lastUser >= 0 && !(prompt[lastUser]!.role === "user" && new RegExp(MARKER_PATTERN.source, "u").test(messageText(prompt[lastUser]!)))) {
    lastUser -= 1;
  }
  if (lastUser < 0) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
  const results: ToolResult[] = [];
  for (const message of prompt.slice(lastUser + 1)) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") results.push({ output: part.output as ToolResult["output"], toolName: part.toolName });
    }
  }
  return { results, user: messageText(prompt[lastUser]!) };
}

function resultText(result: ToolResult): string {
  return typeof result.output.value === "string" ? result.output.value : JSON.stringify(result.output.value);
}

function streamOf(step: Step, callId: string): ReadableStream<LanguageModelV4StreamPart> {
  const usage = { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } };
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if ("text" in step) {
    parts.push({ id: "t0", type: "text-start" }, { delta: step.text, id: "t0", type: "text-delta" }, { id: "t0", type: "text-end" });
  } else {
    parts.push({ input: JSON.stringify(step.toolCall.input), toolCallId: callId, toolName: step.toolCall.name, type: "tool-call" });
  }
  parts.push({ finishReason: { raw: undefined, unified: "text" in step ? "stop" : "tool-calls" }, type: "finish", usage });
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
}

async function rootStep(db: Pick<Pool, "query">, marker: string, user: string, results: readonly ToolResult[]): Promise<Step> {
  const flags = marker.slice(marker.lastIndexOf("-") + 1);
  const has = (name: string) => results.some((result) => result.toolName === name);
  if (flags.includes("m") && !user.includes('"triggeredBy":"mention"')) throw new Error("TEST_GROUP_TRIGGER_MISSING");
  if (flags.includes("x")) {
    if (!user.includes('"triggeredBy":"name_in_text"')) throw new Error("TEST_GROUP_TRIGGER_MISSING");
    return { text: EMPTY_DELIVERY_MARKER };
  }
  if (flags.includes("f")) throw new Error("TEST_MODEL_FAILURE");
  if (flags.includes("p") && !has("manage_profile_projection")) {
    const policy = (await db.query<{ group_ref: string }>(
      `SELECT p.group_ref FROM external_profile_projection_policies p JOIN telegram_groups g ON g.id = p.group_id
        WHERE g.telegram_chat_id = $1`, [String(E2E_EXTERNAL_CHAT_ID)],
    )).rows[0];
    if (!policy) throw new Error("TEST_PROFILE_PROJECTION_GROUP_MISSING");
    return { toolCall: { input: { action: "update", enabled: true, groupRef: policy.group_ref }, name: "manage_profile_projection" } };
  }
  if (results.some((result) => result.output.type === "error-text" && !resultText(result).includes("AGENT_TOOL_OUTCOME_UNKNOWN"))) {
    throw new Error(`TEST_TOOL_FAILED: ${JSON.stringify(results.at(-1))}`);
  }
  if (flags.includes("s") && !has("load_skill")) return { toolCall: { input: { skill: "pohuy" }, name: "load_skill" } };
  if (flags.includes("d") && !has("agent")) return { toolCall: { input: { message: `child:${marker}` }, name: "agent" } };
  if (!flags.includes("p") && !has("bash")) {
    const hold = flags.includes("k") ? " # e2e-block" : flags.includes("h") ? ` # e2e-hold:${marker}` : "";
    return { toolCall: { input: { command: `printf 'BASH:${marker}\\n'${hold}` }, name: "bash" } };
  }
  if (flags.includes("w")) {
    while ((await db.query(`SELECT 1 FROM ${E2E_TABLES.releases} WHERE marker = $1`, [marker])).rowCount !== 1) {
      await sleep(RELEASE_POLL_MILLISECONDS);
    }
  }
  return { text: `reply-${marker}` };
}

export function createScriptedModel(db: Pick<Pool, "query">): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const { results, user } = currentTurn(options.prompt);
      const child = options.prompt.some((message) => message.role === "user" && messageText(message).startsWith(SUBAGENT_OPENING));
      const marker = [...user.matchAll(MARKER_PATTERN)].at(-1)?.[0];
      if (marker === undefined) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
      const tools = (options.tools ?? []).map((tool) => tool.name);
      await db.query(
        `INSERT INTO ${E2E_TABLES.modelCalls} (marker, role, tool_results, tools) VALUES ($1, $2, $3, $4)`,
        [marker, child ? "child" : "root", results.length, tools],
      );
      if (child && (tools.includes("agent") || tools.includes("remember"))) throw new Error("TEST_CHILD_ROOT_AUTHORITY_LEAK");
      const step = child ? { text: `child-${marker}` } : await rootStep(db, marker, user, results);
      return { stream: streamOf(step, `call-${marker}-${results.length}`) };
    },
  });
}
