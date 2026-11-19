/**
 * Creating and running the turns of a background task in its own session (#519).
 *
 * Exports:
 * - `BackgroundTaskTurnPurpose`: the first turn, a continuation with messages, or the summary turn.
 * - `createBackgroundTaskTurn`: in one transaction, the task's application session (one per task, of the
 *   `background` kind), its runtime session, the turn, the messages its input took, and the task's binding.
 * - `runBackgroundTaskTurn`: runs a turn to its end under the dispatcher's signal, waiting while the session
 *   is busy, and returns the stored outcome of a turn that already ended.
 * - `summaryReasonText`: why a summary turn was asked for, as the model reads it.
 *
 * Key constructs:
 * - The task does not see the conversation: everything it needs is in its task text, written by the main
 *   agent, and in the messages that reach it later.
 * - Its own browser session and folder keep it out of the main agent's way in the shared sandbox.
 */
import type { Pool } from "pg";

import { loadInitiatorAuth } from "../../runtime/history/history-repository.js";
import { openChannelSession } from "../../runtime/session/channel-session.js";
import { inJournalTransaction, loadTurn, type JournalDatabase } from "../../runtime/turn/journal-repository.js";
import { runTurn, type TurnOutcome, type TurnRuntime } from "../../runtime/turn/run-turn.js";
import { storedTurnOutcome } from "../../runtime/turn/turn-observation.js";
import { startTurnWithClient } from "../../runtime/turn/turn-start.js";
import { formatCurrentTimeContext } from "../current-time.js";
import { escapeUntrustedContextJson } from "../untrusted-context-json.js";
import { backgroundTaskAuth, type BackgroundTaskAccess } from "./background-task-access.js";
import {
  BACKGROUND_TASK_ACTIVE_LIMIT_MS,
  BACKGROUND_TASK_STEP_LIMIT,
} from "./background-task-config.js";
import { backgroundTaskMessageRepository } from "./background-task-message-repository.js";
import type { BackgroundTask, BackgroundTaskSummaryReason } from "./background-task-records.js";
import { backgroundTaskBrowserSession } from "./background-task-browser.js";
import { BACKGROUND_TASK_CHANNEL_KIND, backgroundTaskToken } from "./background-task-session.js";
import { backgroundTaskFolder } from "./background-task-tools.js";

export type { BackgroundTaskSummaryReason };

export type BackgroundTaskTurnPurpose =
  | { readonly kind: "continue" }
  | { readonly kind: "start" }
  | { readonly kind: "summary"; readonly reason: BackgroundTaskSummaryReason };

// How often a turn waiting for its busy session checks again.
const BUSY_WAIT_MS = 1_000;

export function summaryReasonText(reason: BackgroundTaskSummaryReason): string {
  if (reason === "stopped") return "the person asked to stop the task";
  if (reason === "limit_time") return `the task used up its ${BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000} minutes of work`;
  return `the task used up its ${BACKGROUND_TASK_STEP_LIMIT} model steps`;
}

function startMessage(task: BackgroundTask, folder: string): string {
  return [
    "<background_task>",
    "You are a background task of the family assistant. You work alone: nobody sees your intermediate text, and the chat goes on without you. When you finish, the main agent reads your final answer and retells it to the person.",
    `task_id: ${task.id}`,
    `title: ${escapeUntrustedContextJson(task.title)}`,
    `your_folder: ${folder} — create it and write every file you make there; read the person's files elsewhere, but do not change them.`,
    `browser: run agent-browser with AGENT_BROWSER_SESSION=${backgroundTaskBrowserSession(task.id)} so that you never touch the main agent's browser. Keep to this one session and open more pages as tabs: the sandbox is shared with the chat, and a second browser takes most of its room. Close it (\`agent-browser close\`) once you no longer need it; when the task ends it is closed for you.`,
    `limits: ${BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000} minutes of work and ${BACKGROUND_TASK_STEP_LIMIT} model steps; at either limit you are stopped and asked for a short summary.`,
    "question: if something important cannot be decided without the person, call ask_person once and end the turn; the answer comes in your next turn.",
    "confirmation: nobody can press a button for you. If an action needs a person's confirmation or a change outside your folder (Google, settings, memory), do not do it: say in the result what the main agent should do.",
    "result: end with a final answer — what was done, the result itself, the full paths of the files you made, and what is left undone.",
    "task:",
    task.task,
    "</background_task>",
  ].join("\n");
}

function continueMessage(task: BackgroundTask, messages: readonly { readonly text: string }[]): string {
  return [
    "<background_task_continue>",
    `task_id: ${task.id}`,
    "The main agent sent these on behalf of the person: an answer to your question or a correction. They are newer than your task text: where they differ, follow them.",
    escapeUntrustedContextJson(messages.map((message) => message.text)),
    "Continue the task taking them into account, and end with a final answer as before.",
    "</background_task_continue>",
  ].join("\n");
}

function summaryMessage(task: BackgroundTask, reason: BackgroundTaskSummaryReason): string {
  return [
    "<background_task_summary>",
    `task_id: ${task.id}`,
    `The work is over: ${summaryReasonText(reason)}. You have no tools now.`,
    "In a few sentences write what you managed to do, the partial result, the full paths of the files you made, and what is left undone.",
    "</background_task_summary>",
  ].join("\n");
}

/** One application session per task: the same token always finds it again. */
async function ensureApplicationSession(
  client: Pick<Pool, "query">,
  task: BackgroundTask,
  now: Date,
): Promise<string> {
  const token = backgroundTaskToken(task.id);
  const result = await client.query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        telegram_forum_topic_id, conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, $3, $4, 'background', 'running', $5, $6, $6, $7, $7)
     ON CONFLICT (continuation_token) DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at
     RETURNING id::text`,
    [task.familyId, task.groupId === null ? task.authorUserId : null, task.groupId,
      task.groupId === null ? "personal" : "family", task.forumTopicId, token, now],
  );
  return result.rows[0]!.id;
}

export async function createBackgroundTaskTurn(
  database: JournalDatabase & Pick<Pool, "query">,
  input: {
    readonly access: BackgroundTaskAccess;
    readonly now: Date;
    readonly purpose: BackgroundTaskTurnPurpose;
    readonly task: BackgroundTask;
  },
): Promise<{ readonly turnId: string }> {
  const { now, purpose, task } = input;
  const token = backgroundTaskToken(task.id);
  return await inJournalTransaction(database, async (client) => {
    const applicationSessionId = await ensureApplicationSession(client, task, now);
    const auth = backgroundTaskAuth({ access: input.access, applicationSessionId, now, summary: purpose.kind === "summary", task });
    const sessionId = await openChannelSession(client, { auth, channelKind: BACKGROUND_TASK_CHANNEL_KIND, channelState: null, token });
    // A summary turn says only what was done; corrections still waiting stay for the next turn, if any.
    const messages = purpose.kind === "summary" ? [] : await backgroundTaskMessageRepository.lockUndelivered(client, task.id);
    const folder = backgroundTaskFolder(auth.attributes.groupType, task.id);
    const message = purpose.kind === "start" ? startMessage(task, folder)
      : purpose.kind === "summary" ? summaryMessage(task, purpose.reason)
      : continueMessage(task, messages);
    const turn = await startTurnWithClient(client, {
      auth: { current: auth, initiator: await loadInitiatorAuth(client, sessionId) },
      channel: { continuationToken: token, kind: BACKGROUND_TASK_CHANNEL_KIND },
      input: { context: [formatCurrentTimeContext(now)], message },
      kind: "background",
      parent: null,
      sessionId,
    });
    // The first turn's own message is the task; messages that came before it are a continuation's.
    if (purpose.kind === "continue") {
      await backgroundTaskMessageRepository.markTakenByTurn(client, messages.map((item) => item.id), turn.id, now);
    }
    await client.query(
      `UPDATE background_tasks SET application_session_id = $2, agent_session_id = $3, current_turn_id = $4, updated_at = $5
        WHERE id = $1`,
      [task.id, applicationSessionId, sessionId, turn.id, now],
    );
    return { turnId: turn.id };
  });
}

export async function runBackgroundTaskTurn(runtime: TurnRuntime, turnId: string, signal: AbortSignal): Promise<TurnOutcome> {
  for (;;) {
    const outcome = await runTurn(runtime, turnId, { abortSignal: signal });
    if (outcome.status !== "busy") return outcome;
    const turn = await loadTurn(runtime.database, turnId);
    if (turn.status !== "running") return await storedTurnOutcome(runtime.database, turn);
    if (signal.aborted) return { status: "cancelled" };
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
}
