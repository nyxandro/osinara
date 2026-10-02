/**
 * Carries the conversation history of every active application session over from Eve's database.
 *
 * Export:
 * - `importEveHistory`: imports, or in dry run only reads and counts, each active session's history.
 *
 * Source: for an active `conversation_sessions` row, the latest completed Eve turn run whose
 * `$eve.parent` is the session, and in it the latest completed `turnStep` output, which holds the
 * session snapshot after that turn. The history keeps the session id, so every reference to it in
 * application tables stays valid.
 *
 * Outcomes per session:
 * - `imported` / `would_import`: history written, or readable in dry run.
 * - `already_imported`: the runtime already holds this session; a repeated run changes nothing.
 * - `source_absent`: Eve has no completed turn for it (its run was already cleaned up). The session
 *   starts with an empty history, which is what the previous version would have done as well, and
 *   `AGENT_EVE_HISTORY_SOURCE_ABSENT` is logged with the session id.
 * A snapshot that exists but cannot be read stops the whole import with
 * `AGENT_EVE_HISTORY_IMPORT_FAILED`; nothing is skipped silently.
 */
import { bindContinuation } from "../session/continuations.js";
import { TELEGRAM_CHANNEL_KIND } from "../telegram/channel-types.js";
import { createSessionHistory, type HistoryClient, type NewSessionHistory } from "./history-repository.js";
import { decodeEveTurnStepOutput, type EveSessionSnapshot } from "./eve-snapshot.js";
import { AppError } from "../../lib/app-error.js";
import type { SessionAuthContext } from "../context.js";

const TURN_WORKFLOW_NAME = "workflow//eve//turnWorkflow";
const TURN_STEP_NAME = "step//eve@0.40.0//turnStep";

export type EveHistoryImportOutcome = "already_imported" | "imported" | "source_absent" | "would_import";

export interface EveHistoryImportSession {
  readonly messages: number;
  readonly outcome: EveHistoryImportOutcome;
  readonly sessionId: string;
}

export interface EveHistoryImportInput {
  /** Application database; for a real import, a client inside the caller's transaction. */
  readonly app: HistoryClient;
  readonly dryRun: boolean;
  readonly log: (event: Record<string, unknown>) => void;
  readonly workflow: HistoryClient;
}

async function runtimeTableExists(app: HistoryClient): Promise<boolean> {
  const result = await app.query<{ present: boolean }>("SELECT to_regclass('agent_session_state') IS NOT NULL AS present");
  return result.rows[0]!.present;
}

async function latestSnapshot(workflow: HistoryClient, sessionId: string): Promise<Uint8Array | null> {
  const turn = (await workflow.query<{ id: string }>(
    `SELECT id FROM workflow.workflow_runs
      WHERE name = $1 AND status = 'completed' AND attributes->>'$eve.parent' = $2
      ORDER BY completed_at DESC, id DESC LIMIT 1`,
    [TURN_WORKFLOW_NAME, sessionId],
  )).rows[0];
  if (!turn) return null;
  const step = (await workflow.query<{ output_cbor: Buffer | null }>(
    `SELECT output_cbor FROM workflow.workflow_steps
      WHERE run_id = $1 AND step_name = $2 AND status = 'completed'
      ORDER BY completed_at DESC, step_id DESC LIMIT 1`,
    [turn.id, TURN_STEP_NAME],
  )).rows[0];
  if (!step?.output_cbor) {
    throw new AppError("AGENT_EVE_HISTORY_IMPORT_FAILED", "У завершённого хода Eve нет снимка сессии", {
      details: { sessionId, turnRunId: turn.id },
    });
  }
  return new Uint8Array(step.output_cbor);
}

function counter(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function newImportedHistory(
  session: { application_session_id: string; continuation_token: string; session_id: string },
  snapshot: EveSessionSnapshot | null,
): NewSessionHistory {
  const identity = {
    applicationSessionId: session.application_session_id,
    parentSessionId: null,
    sessionId: session.session_id,
    source: "eve_import",
  } as const;
  if (snapshot === null) {
    return {
      ...identity, announcedSkills: null, channelState: null, compaction: { inputTokens: null, promptMessageCount: null },
      history: [], initiatorAuth: null, sandbox: null, todo: null,
    };
  }
  return {
    ...identity,
    announcedSkills: snapshot.announcedSkills,
    channelState: snapshot.channelState,
    compaction: snapshot.compaction === null
      ? { inputTokens: null, promptMessageCount: null }
      : {
        inputTokens: counter(snapshot.compaction.lastKnownInputTokens),
        promptMessageCount: counter(snapshot.compaction.lastKnownPromptMessageCount),
      },
    history: snapshot.history,
    initiatorAuth: snapshot.initiatorAuth as unknown as SessionAuthContext | null,
    sandbox: snapshot.sandbox,
    todo: snapshot.todo,
  };
}

export async function importEveHistory(input: EveHistoryImportInput): Promise<EveHistoryImportSession[]> {
  const sessions = (await input.app.query<{ application_session_id: string; continuation_token: string; session_id: string }>(
    `SELECT id AS application_session_id, continuation_token, eve_session_id AS session_id FROM conversation_sessions
      WHERE retired_at IS NULL AND eve_session_id IS NOT NULL ORDER BY eve_session_id`,
  )).rows;
  // A dry run before the release reads a database that does not have the runtime tables yet.
  const tableExists = await runtimeTableExists(input.app);
  const results: EveHistoryImportSession[] = [];
  for (const session of sessions) {
    const imported = tableExists && (await input.app.query(
      "SELECT 1 FROM agent_session_state WHERE session_id = $1", [session.session_id],
    )).rowCount === 1;
    if (imported) {
      results.push({ messages: 0, outcome: "already_imported", sessionId: session.session_id });
      continue;
    }
    const stored = await latestSnapshot(input.workflow, session.session_id);
    const snapshot = stored === null ? null : decodeEveTurnStepOutput(stored);
    if (snapshot !== null && snapshot.sessionId !== session.session_id) {
      throw new AppError("AGENT_EVE_HISTORY_IMPORT_FAILED", "Снимок принадлежит другой сессии", {
        details: { sessionId: session.session_id, snapshotSessionId: snapshot.sessionId },
      });
    }
    if (snapshot === null) input.log({ code: "AGENT_EVE_HISTORY_SOURCE_ABSENT", sessionId: session.session_id });
    if (!input.dryRun) {
      await createSessionHistory(input.app, newImportedHistory(session, snapshot));
      // Every conversation session is a Telegram one; its address keeps leading to it.
      await bindContinuation(input.app, { channelKind: TELEGRAM_CHANNEL_KIND, sessionId: session.session_id, token: session.continuation_token });
    }
    results.push({
      messages: snapshot === null ? 0 : snapshot.history.length,
      outcome: snapshot === null ? "source_absent" : input.dryRun ? "would_import" : "imported",
      sessionId: session.session_id,
    });
  }
  return results;
}
