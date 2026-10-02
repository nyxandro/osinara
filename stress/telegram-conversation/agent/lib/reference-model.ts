/**
 * Deterministic model behavior for the reference-request scenarios.
 *
 * Export:
 * - `respondToReferenceRequest`: the next tool call of the scenario script, or its final answer.
 *
 * Each script calls its tools in order, one per model step, then answers `reply-<marker>`
 * (`child-<marker>` in a subagent). Call ids name the scenario and step, so a turn counts only its
 * own results even when the session history already holds earlier scenarios. Any failed or
 * missing tool fails the run, so a fixture is never captured from a turn that went another way.
 */
import type { MockModelRequest, MockModelResponse, MockModelToolCall } from "eve/evals";

import { database } from "../../../../agent/lib/database.js";
import {
  REFERENCE_EXTERNAL_CHAT_ID,
  type ReferenceRequestIdentity,
  type ReferenceScenario,
  referenceMarker,
} from "./reference-scenarios.js";

const REVIEW_BATCH_TAG = "<untrusted_memory_review_batch>";

type ScriptStep = (request: MockModelRequest) => MockModelToolCall | Promise<MockModelToolCall>;

function bash(marker: string): ScriptStep {
  return () => ({ name: "bash", input: { command: `printf 'BASH:${marker}\\n'` } });
}

async function externalGroupRef(): Promise<string> {
  const policy = (await database().query<{ group_ref: string }>(
    `SELECT policy.group_ref FROM external_profile_projection_policies policy
       JOIN telegram_groups chat ON chat.id = policy.group_id
      WHERE chat.telegram_chat_id = $1`,
    [String(REFERENCE_EXTERNAL_CHAT_ID)],
  )).rows[0];
  if (!policy) throw new Error("TEST_REFERENCE_PROFILE_PROJECTION_GROUP_MISSING");
  return policy.group_ref;
}

function reviewScope(request: MockModelRequest): string {
  const scope = request.messages.find((message) => message.role === "system")?.text
    .match(/сохраняй в scope "([a-z]+)"/u)?.[1];
  if (!scope) throw new Error("TEST_REFERENCE_REVIEW_SCOPE_MISSING");
  return scope;
}

// The review also shows an already reviewed tail; only an entry of the batch itself is a source.
function firstReviewSourceSequence(request: MockModelRequest): string {
  const batch = request.userMessages.find((text) => text.includes(REVIEW_BATCH_TAG));
  const sequence = batch?.slice(batch.indexOf(REVIEW_BATCH_TAG)).match(/"sourceSequence":"?(\d+)/u)?.[1];
  if (!sequence) throw new Error("TEST_REFERENCE_REVIEW_SOURCE_MISSING");
  return sequence;
}

function rootScript(scenario: ReferenceScenario): readonly ScriptStep[] {
  const marker = referenceMarker(scenario);
  switch (scenario) {
    case "private-first":
      return [
        () => ({ name: "load_skill", input: { skill: "pohuy" } }),
        () => ({ name: "agent", input: { message: `child:${marker}` } }),
        bash(marker),
        () => ({ name: "probe_workspace", input: { marker } }),
        () => ({ name: "remember", input: {
          basis: "user_requested",
          content: `Владелец проверяет эталонный ход ${marker}`,
          kind: "fact",
          scope: "personal",
          sensitivity: "normal",
          subject: { kind: "current_author" },
        } }),
      ];
    case "family-group":
    case "external-human":
    case "scheduled-isolated":
      return [bash(marker)];
    case "approval":
      return [async () => ({ name: "manage_profile_projection", input: {
        action: "update", enabled: true, groupRef: await externalGroupRef(),
      } })];
    case "question":
      return [() => ({ name: "ask_question", input: {
        allowFreeform: false,
        options: [{ id: "continue", label: "Продолжить" }],
        prompt: "Продолжить эталонную проверку?",
      } })];
    case "memory-review":
      return [(request) => ({ name: "remember", input: {
        basis: "agent_inferred",
        content: "Участник группы проверяет эталонные ходы ассистента",
        kind: "fact",
        scope: reviewScope(request),
        sensitivity: "normal",
        sourceSequence: firstReviewSourceSequence(request),
        subject: { kind: "none" },
      } })];
    case "private-second":
    case "external-bot":
    case "scheduled-conversation":
      return [];
  }
}

export async function respondToReferenceRequest(
  request: MockModelRequest,
  identity: ReferenceRequestIdentity,
): Promise<MockModelResponse | string> {
  const callIdPrefix = `call-${identity.scenario}-${identity.child ? "child" : "root"}-`;
  const own = request.toolResults.filter((result) => result.id.startsWith(callIdPrefix));
  const failed = own.find((result) => result.isError);
  if (failed) throw new Error(`TEST_REFERENCE_TOOL_FAILED: ${JSON.stringify(failed)}`);
  const marker = referenceMarker(identity.scenario);
  const script = identity.child ? [bash(marker)] : rootScript(identity.scenario);
  const step = script[own.length];
  if (step === undefined) return identity.child ? `child-${marker}` : `reply-${marker}`;
  const call = await step(request);
  if (!request.tools.some((tool) => tool.name === call.name)) {
    throw new Error(`TEST_REFERENCE_TOOL_MISSING: ${identity.scenario} ${call.name}`);
  }
  return { toolCalls: [{ ...call, id: `${callIdPrefix}${own.length + 1}` }] };
}
