/**
 * Reader of the session snapshot that Eve 0.40.0 stores after every turn step.
 *
 * Export:
 * - `decodeEveTurnStepOutput`: the stored `turnStep` output as history plus the session state the
 *   own runtime carries over: compaction counters, the `todo` list and the announced skill set.
 *
 * Storage layers, outermost first, as written by @workflow/world-postgres and @workflow/core:
 * CBOR byte string → optional `zstd` or `gzip` prefix with compressed bytes → `devl` prefix with a
 * devalue string → `{ sessionState: { snapshot: { version: 1, session } }, serializedContext }`.
 * The history is AI SDK `ModelMessage[]` with plain JSON values; anything else, including an
 * encrypted payload or a custom serialized type, stops the import instead of being skipped.
 */
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import type { ModelMessage } from "ai";
import { decode } from "cbor-x";
import { parse } from "devalue";

import { AppError } from "../../lib/app-error.js";
import type { AnnouncedSkill } from "../skills/definition.js";
import { isObject } from "../json.js";
import { describeHistoryProblem, firstNonJsonPath } from "./model-message-shape.js";

export interface EveCompactionCounters {
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
}

export interface EveSessionSnapshot {
  readonly announcedSkills: readonly AnnouncedSkill[] | null;
  readonly compaction: EveCompactionCounters | null;
  readonly history: ModelMessage[];
  /** The channel state Eve kept (chat, topic, pending buttons and their counter). */
  readonly channelState: Record<string, unknown> | null;
  /** The sandbox runner metadata Eve kept for the session; the runner backend validates it on use. */
  readonly sandbox: Record<string, unknown> | null;
  readonly sessionId: string;
  readonly todo: Record<string, unknown> | null;
}

const SNAPSHOT_VERSION = 1;
const PREFIX_LENGTH = 4;
// Eve keys the durable skill manifest by resolver slug; the application has exactly one.
const SKILL_RESOLVER_SLUG = "scoped";
// The only sandbox backend Osinara ran on Eve (`runner-sandbox-profile.ts`).
const SANDBOX_BACKEND_NAME = "osinara-scoped-runner-v3";

function importFailure(reason: string, cause?: unknown): AppError {
  return new AppError(
    "AGENT_EVE_HISTORY_IMPORT_FAILED",
    `Не удалось прочитать историю разговора из базы Eve: ${reason}`,
    cause === undefined ? undefined : { cause },
  );
}

function decodeLayers(stored: Uint8Array): string {
  let bytes: unknown;
  try {
    bytes = decode(stored);
  } catch (error) {
    throw importFailure("снимок не является CBOR", error);
  }
  if (!(bytes instanceof Uint8Array)) throw importFailure("снимок не является байтовой строкой");
  let payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (;;) {
    const prefix = payload.subarray(0, PREFIX_LENGTH).toString("latin1");
    const body = payload.subarray(PREFIX_LENGTH);
    try {
      if (prefix === "zstd") payload = zstdDecompressSync(body);
      else if (prefix === "gzip") payload = gunzipSync(body);
      else if (prefix === "devl") return body.toString("utf8");
      else throw importFailure(`неизвестный формат «${prefix}»`);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw importFailure(`не удалось распаковать слой «${prefix}»`, error);
    }
  }
}

function requireHistory(value: unknown): ModelMessage[] {
  const problem = describeHistoryProblem(value);
  if (problem !== null) throw importFailure(problem);
  return value as ModelMessage[];
}

function readCompaction(value: unknown): EveCompactionCounters | null {
  if (value === undefined) return null;
  if (!isObject(value)) throw importFailure("счётчики сжатия имеют неверный вид");
  for (const key of ["lastKnownInputTokens", "lastKnownPromptMessageCount"] as const) {
    const counter = value[key];
    if (counter !== undefined && !(Number.isInteger(counter) && (counter as number) >= 0)) {
      throw importFailure(`счётчик сжатия ${key} не является неотрицательным целым`);
    }
  }
  return value as EveCompactionCounters;
}

function readTodo(state: unknown): Record<string, unknown> | null {
  if (state === undefined) return null;
  if (!isObject(state)) throw importFailure("состояние сессии имеет неверный вид");
  const todo = state["eve.todo"];
  if (todo === undefined) return null;
  if (!isObject(todo) || !Array.isArray(todo.items) || firstNonJsonPath(todo, "todo") !== null) {
    throw importFailure("список todo имеет неверный вид");
  }
  return todo;
}

function readAnnouncedSkills(manifest: unknown): readonly AnnouncedSkill[] | null {
  if (manifest === undefined) return null;
  if (!isObject(manifest) || Object.keys(manifest).some((slug) => slug !== SKILL_RESOLVER_SLUG)) {
    throw importFailure("список объявленных скиллов имеет неверный вид");
  }
  const skills = manifest[SKILL_RESOLVER_SLUG];
  if (skills === undefined) return null;
  if (!Array.isArray(skills) || !skills.every((skill) =>
    isObject(skill) && typeof skill.name === "string" && typeof skill.description === "string")) {
    throw importFailure("список объявленных скиллов имеет неверный вид");
  }
  return skills.map((skill) => ({ name: skill.name as string, description: skill.description as string }));
}

// Every conversation session Osinara ran on Eve was a Telegram one.
function readChannelState(channel: unknown): Record<string, unknown> | null {
  if (channel === undefined) return null;
  if (!isObject(channel) || channel.kind !== "telegram" || !isObject(channel.state)) {
    throw importFailure("состояние канала имеет неверный вид");
  }
  return channel.state;
}

function readSandbox(state: unknown): Record<string, unknown> | null {
  if (state === undefined) return null;
  if (!isObject(state)) throw importFailure("состояние sandbox имеет неверный вид");
  // A session that never opened its sandbox has nothing to keep.
  if (state.initialized !== true || state.session === undefined || state.session === null) return null;
  const session = state.session;
  if (!isObject(session) || session.backendName !== SANDBOX_BACKEND_NAME || !isObject(session.metadata)) {
    throw importFailure("состояние sandbox принадлежит неизвестному хранилищу");
  }
  return session.metadata;
}

export function decodeEveTurnStepOutput(stored: Uint8Array): EveSessionSnapshot {
  const serialized = decodeLayers(stored);
  let output: unknown;
  try {
    // No revivers: every custom type Workflow can serialize is outside the supported format.
    output = parse(serialized, {});
  } catch (error) {
    throw importFailure("не удалось разобрать сериализованное значение", error);
  }
  if (!isObject(output) || !isObject(output.sessionState) || !isObject(output.sessionState.snapshot)) {
    throw importFailure("в результате шага нет снимка сессии");
  }
  const snapshot = output.sessionState.snapshot;
  if (snapshot.version !== SNAPSHOT_VERSION) throw importFailure(`версия снимка ${String(snapshot.version)}`);
  const session = snapshot.session;
  if (!isObject(session) || typeof session.sessionId !== "string" || session.sessionId.length === 0) {
    throw importFailure("в снимке нет идентификатора сессии");
  }
  const context = isObject(output.serializedContext) ? output.serializedContext : {};
  return {
    announcedSkills: readAnnouncedSkills(context["eve.dynamicSkillManifest"]),
    channelState: readChannelState(context["eve.channel"]),
    compaction: readCompaction(session.compaction),
    history: requireHistory(session.history),
    sandbox: readSandbox(session.sandboxState),
    sessionId: session.sessionId,
    todo: readTodo(session.state),
  };
}
