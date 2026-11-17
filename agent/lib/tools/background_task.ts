/**
 * The main agent's tool for background tasks (#519): start one, ask how it goes, correct it, stop it.
 *
 * Export:
 * - default `background_task` tool.
 *
 * Key constructs:
 * - Only a live turn answering a person's message in a private chat or a family group may use it. The
 *   descriptor is also in wake-ups and in turns that bring a task's report (their tool set stays the
 *   conversation's, byte for byte, for the provider's cache), but there it refuses: no task starts
 *   without a person, and no task starts another.
 * - A task is seen and managed only from its own chat and topic; another chat gets "no such task".
 * - A repeat of the same call after a restart returns the same task or adds nothing: the pair (turn, call)
 *   is its key.
 */
import { z } from "zod";

import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { AppError } from "../app-error.js";
import {
  BACKGROUND_TASK_ACTIVE_LIMIT_MS,
  BACKGROUND_TASK_CONCURRENCY,
  BACKGROUND_TASK_MESSAGE_MAX_LENGTH,
  BACKGROUND_TASK_STATUS_WINDOW_MS,
  BACKGROUND_TASK_STEP_LIMIT,
  BACKGROUND_TASK_STUCK_MS,
  BACKGROUND_TASK_TEXT_MAX_LENGTH,
  BACKGROUND_TASK_TITLE_MAX_LENGTH,
} from "../background-tasks/background-task-config.js";
import { lastBackgroundTaskTools } from "../background-tasks/background-task-journal.js";
import { backgroundTaskMessageRepository } from "../background-tasks/background-task-message-repository.js";
import { activeMsAt, isActiveState, type BackgroundTask, type BackgroundTaskChat } from "../background-tasks/background-task-records.js";
import { backgroundTaskRepository } from "../background-tasks/background-task-repository.js";
import { isConversationWakeupTurn } from "../conversation-wakeups/conversation-wakeup-events.js";
import { database } from "../database.js";
import { isRestrictedChildTurn } from "../restricted-child-turn.js";

const STATUS_LIST_LIMIT = 10;
const STATUS_LAST_TOOLS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const taskId = z.string().regex(/^[1-9]\d{0,17}$/u).describe("The task number, as start or status returned it");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    task: z.string().trim().min(1).max(BACKGROUND_TASK_TEXT_MAX_LENGTH)
      .describe("The whole assignment: what to do, which files or sources, what to produce and where. The task does not see this conversation."),
    title: z.string().trim().min(1).max(BACKGROUND_TASK_TITLE_MAX_LENGTH).describe("A short name the person will recognize"),
  }).strict(),
  z.object({ action: z.literal("status"), id: taskId.optional() }).strict(),
  z.object({
    action: z.literal("message"),
    id: taskId,
    text: z.string().trim().min(1).max(BACKGROUND_TASK_MESSAGE_MAX_LENGTH).describe("A correction, or the person's answer to the task's question"),
  }).strict(),
  z.object({ action: z.literal("stop"), id: taskId }).strict(),
]);

const DESCRIPTION = [
  "Run long independent work in the background so the chat stays free, and manage it.",
  `start: for work that takes more than a few minutes and needs no person at each step (process many files, research, a long build). Not for something you can do in a minute, and not for work where the person decides at each step. A task gets up to ${BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000} minutes and ${BACKGROUND_TASK_STEP_LIMIT} steps; up to three run at once, the rest wait in a queue. Its result comes back to you as a message, and you retell it.`,
  "status: without id, the tasks of this chat of the last day; with id, one task. Use it when asked how a task goes, and before message or stop.",
  "message: a correction for a running task, or the person's answer to a task's question.",
  "stop: stops a task; it then writes what it managed, and that comes back to you.",
].join(" ");

function notAllowed(): AppError {
  return new AppError("AGENT_BACKGROUND_TASK_NOT_ALLOWED", "Фоновые задачи здесь недоступны: сделай работу в разговоре", { isExpectedRefusal: true });
}

function notFound(): AppError {
  return new AppError("AGENT_BACKGROUND_TASK_NOT_FOUND", "В этом чате нет такой задачи", { isExpectedRefusal: true });
}

function alreadyEnded(task: BackgroundTask): AppError {
  if (task.state === "stopping") {
    return new AppError("AGENT_BACKGROUND_TASK_STOPPING", "Задача уже останавливается и поправку не увидит; её итог придёт сам", { isExpectedRefusal: true });
  }
  return new AppError(
    "AGENT_BACKGROUND_TASK_FINISHED",
    `Задача уже закончилась (${task.state === "reported" ? "итог отправлен" : task.state}); итог смотри в status`,
    { isExpectedRefusal: true },
  );
}

interface LiveChat extends BackgroundTaskChat {
  readonly authorUserId: string;
  readonly familyId: string;
  readonly groupId: string | null;
  readonly messageThreadId: string | null;
  readonly sandboxSessionId: string;
  readonly telegramChatType: BackgroundTask["telegramChatType"];
  readonly updateId: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The verified chat of a live turn in a private chat or a family group, or a refusal. */
function requireLiveChat(ctx: ToolContext): LiveChat {
  if (isRestrictedChildTurn(ctx.session) || isScheduledSession(ctx) || isConversationWakeupTurn(ctx)) throw notAllowed();
  const caller = ctx.session.auth.current;
  const attributes = caller?.attributes;
  const chatType = attributes?.telegramChatType;
  const updateId = text(attributes?.osinaraTelegramUpdateId);
  const familyId = text(attributes?.familyId);
  const telegramChatId = text(attributes?.telegramChatId);
  const sandboxSessionId = text(attributes?.sandboxSessionId);
  if (!caller || caller.authenticator !== "telegram" || attributes?.telegramActorKind !== "telegram_user" ||
    !UUID.test(caller.principalId) || updateId === null || familyId === null || telegramChatId === null || sandboxSessionId === null) {
    throw notAllowed();
  }
  const family = attributes.groupType === "family_private" && text(attributes.groupId) !== null;
  const privateChat = chatType === "private" && attributes.groupType === undefined;
  // An external group never gets a task: the owner's rule, without exceptions.
  if (!privateChat && !(family && (chatType === "group" || chatType === "supergroup"))) throw notAllowed();
  return {
    authorUserId: caller.principalId,
    familyId,
    forumTopicId: text(attributes.telegramForumTopicId),
    groupId: family ? text(attributes.groupId) : null,
    messageThreadId: text(attributes.telegramMessageThreadId),
    sandboxSessionId,
    telegramChatId,
    telegramChatType: chatType as BackgroundTask["telegramChatType"],
    updateId,
  };
}

async function ingressQueueOf(updateId: string): Promise<string | null> {
  const result = await database().query<{ queue_id: string }>(
    "SELECT queue_id::text FROM telegram_ingress_updates WHERE update_id = $1::bigint", [updateId],
  );
  return result.rows[0]?.queue_id ?? null;
}

async function statusOf(task: BackgroundTask, now: Date) {
  const lastStepAgoMinutes = task.lastStepAt === null ? null : Math.floor((now.getTime() - task.lastStepAt.getTime()) / 60_000);
  const running = task.state === "running" || task.state === "stopping";
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    activeMinutes: Math.floor(activeMsAt(task, now) / 60_000),
    limitMinutes: BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000,
    steps: task.steps,
    stepLimit: BACKGROUND_TASK_STEP_LIMIT,
    lastStepAgoMinutes,
    seemsStuck: running && task.lastStepAt !== null && now.getTime() - task.lastStepAt.getTime() >= BACKGROUND_TASK_STUCK_MS,
    note: task.note,
    lastTools: running || task.state === "waiting_answer" ? await lastBackgroundTaskTools(database(), task.agentSessionId, STATUS_LAST_TOOLS) : [],
    waitingQuestion: task.waitingQuestion,
    ...(isActiveState(task.state) ? {} : { outcome: task.outcomeText, files: task.outcomeFiles, outcomeCode: task.outcomeCode }),
  };
}

export default defineTool({
  // Every action is keyed by the pair (turn, call) or only reads: a replay changes nothing twice.
  replaySafe: true,
  description: DESCRIPTION,
  inputSchema,
  async execute(input, ctx) {
    const chat = requireLiveChat(ctx);
    const now = new Date();
    const call = { createdByCallId: ctx.callId, createdByTurnId: ctx.session.turn.id };
    if (input.action === "start") {
      const { created, task } = await backgroundTaskRepository.create({
        ...call,
        authorUserId: chat.authorUserId,
        familyId: chat.familyId,
        forumTopicId: chat.forumTopicId,
        groupId: chat.groupId,
        ingressQueueId: await ingressQueueOf(chat.updateId),
        messageThreadId: chat.messageThreadId,
        sandboxSessionId: chat.sandboxSessionId,
        task: input.task,
        telegramChatId: chat.telegramChatId,
        telegramChatType: chat.telegramChatType,
        title: input.title,
      });
      if (created) console.info(JSON.stringify({ code: "AGENT_BACKGROUND_TASK_QUEUED", taskId: task.id }));
      if (task.state !== "queued") return { id: task.id, state: task.state };
      // The dispatcher takes a queued task within seconds when a place is free: say it runs.
      return { id: task.id, state: await backgroundTaskRepository.tasksAhead(task.id) < BACKGROUND_TASK_CONCURRENCY ? "running" : "queued" };
    }
    if (input.action === "status") {
      if (input.id === undefined) {
        const tasks = await backgroundTaskRepository.listInChat(chat, new Date(now.getTime() - BACKGROUND_TASK_STATUS_WINDOW_MS), STATUS_LIST_LIMIT);
        return { tasks: await Promise.all(tasks.map((task) => statusOf(task, now))) };
      }
      const task = await backgroundTaskRepository.findInChat(input.id, chat);
      if (task === null) throw notFound();
      return await statusOf(task, now);
    }
    const task = await backgroundTaskRepository.findInChat(input.id, chat);
    if (task === null) throw notFound();
    if (input.action === "message") {
      const delivered = await backgroundTaskMessageRepository.append({ ...call, authorUserId: chat.authorUserId, now, taskId: task.id, text: input.text });
      // The task may have ended or begun stopping since it was read: say what it is now.
      if (delivered === null) throw alreadyEnded(await backgroundTaskRepository.find(task.id) ?? task);
      return { delivered };
    }
    const state = await backgroundTaskRepository.requestStop(task.id, now);
    if (state === null) throw alreadyEnded(await backgroundTaskRepository.find(task.id) ?? task);
    console.info(JSON.stringify({ code: "AGENT_BACKGROUND_TASK_STOP_REQUESTED", state, taskId: task.id }));
    return { state };
  },
});
