/**
 * The main agent's `background_task` tool (#519).
 *
 * Constructs covered:
 * - Only a live turn answering a person in a private chat or a family group may use it: a wake-up, a task's
 *   report, a scenario, a delegated child, a task itself and an external group are refused.
 * - start records the task with the chat facts of the verified turn, keyed by (turn, call).
 * - A task of another chat or topic does not exist; message and stop to an ended task say it ended.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  find: vi.fn(),
  tasksAhead: vi.fn(),
  findInChat: vi.fn(),
  listInChat: vi.fn(),
  requestStop: vi.fn(),
}));
const messages = vi.hoisted(() => ({ append: vi.fn() }));

vi.mock("../background-tasks/background-task-repository.js", () => ({ backgroundTaskRepository: repository }));
vi.mock("../background-tasks/background-task-message-repository.js", () => ({ backgroundTaskMessageRepository: messages }));
vi.mock("../database.js", () => ({
  database: () => ({ query: vi.fn().mockResolvedValue({ rows: [{ queue_id: "queue-1" }] }) }),
}));

import backgroundTask from "./background_task.js";

const AUTHOR = "0b9a3c3e-6a3f-4b8e-9d1f-2b7f4c8d9e10";
const PRIVATE = {
  familyId: "family-1",
  memoryScopes: ["personal", "family"],
  osinaraTelegramUpdateId: "9001",
  sandboxSessionId: "thread-1",
  telegramActorKind: "telegram_user",
  telegramChatId: "42",
  telegramChatType: "private",
};
const FAMILY = {
  ...PRIVATE, groupId: "group-1", groupType: "family_private", telegramChatId: "-100500", telegramChatType: "supergroup", telegramForumTopicId: "11",
};

function context(attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: AUTHOR, principalType: "user" }, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", kind: "conversation", sequence: 1 },
      ...extra,
    },
    toolName: "background_task",
  } as never;
}

const START = { action: "start", task: "Сведи сроки договоров", title: "Сводка" } as const;

describe("background_task", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses outside a live turn of a private chat or a family group", async () => {
    const refused = [
      context({ ...PRIVATE, conversationScheduleRunId: "run-1" }),
      context({ ...PRIVATE, backgroundTaskEventId: "5" }),
      context({ ...PRIVATE, scheduledRunId: "run-2" }),
      context({ ...PRIVATE, backgroundTaskId: "3" }),
      context(PRIVATE, { parent: { callId: "c", sessionId: "s", turnId: "t" } }),
      context({ ...PRIVATE, groupId: "group-2", groupType: "external", telegramChatType: "supergroup" }),
      context({ ...PRIVATE, osinaraTelegramUpdateId: undefined }),
    ];
    for (const ctx of refused) {
      await expect(backgroundTask.execute(START, ctx)).rejects.toThrow("AGENT_BACKGROUND_TASK_NOT_ALLOWED");
    }
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("starts a task with the verified chat of a family group's topic", async () => {
    repository.create.mockResolvedValue({ created: true, task: { id: "7", state: "queued" } });
    repository.tasksAhead.mockResolvedValue(3);
    await expect(backgroundTask.execute(START, context(FAMILY))).resolves.toEqual({ id: "7", state: "queued" });
    repository.tasksAhead.mockResolvedValue(1);
    await expect(backgroundTask.execute(START, context(FAMILY))).resolves.toEqual({ id: "7", state: "running" });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      authorUserId: AUTHOR, createdByCallId: "call-1", createdByTurnId: "turn-1", familyId: "family-1", forumTopicId: "11",
      groupId: "group-1", ingressQueueId: "queue-1", sandboxSessionId: "thread-1", telegramChatId: "-100500", telegramChatType: "supergroup",
    }));
  });

  it("finds a task only in its own chat and topic", async () => {
    repository.findInChat.mockResolvedValue(null);
    await expect(backgroundTask.execute({ action: "stop", id: "7" }, context(FAMILY))).rejects.toThrow("AGENT_BACKGROUND_TASK_NOT_FOUND");
    expect(repository.findInChat).toHaveBeenCalledWith("7", expect.objectContaining({ forumTopicId: "11", telegramChatId: "-100500" }));
  });

  it("says an ended task ended, for a correction and for a stop", async () => {
    repository.findInChat.mockResolvedValue({ id: "7", state: "reported" });
    repository.find.mockResolvedValue({ id: "7", state: "reported" });
    messages.append.mockResolvedValue(null);
    repository.requestStop.mockResolvedValue(null);
    await expect(backgroundTask.execute({ action: "message", id: "7", text: "ещё" }, context(PRIVATE))).rejects.toThrow("AGENT_BACKGROUND_TASK_FINISHED");
    await expect(backgroundTask.execute({ action: "stop", id: "7" }, context(PRIVATE))).rejects.toThrow("AGENT_BACKGROUND_TASK_FINISHED");
  });

  it("refuses a correction for a task that is being stopped: it would never see it", async () => {
    repository.findInChat.mockResolvedValue({ id: "7", state: "running" });
    repository.find.mockResolvedValue({ id: "7", state: "stopping" });
    messages.append.mockResolvedValue(null);
    await expect(backgroundTask.execute({ action: "message", id: "7", text: "ещё" }, context(PRIVATE))).rejects.toThrow("AGENT_BACKGROUND_TASK_STOPPING");
  });

  it("passes a correction keyed by the call, and reports a resumed task", async () => {
    repository.findInChat.mockResolvedValue({ id: "7", state: "waiting_answer" });
    messages.append.mockResolvedValue("resumes");
    await expect(backgroundTask.execute({ action: "message", id: "7", text: "Отдельно" }, context(PRIVATE))).resolves.toEqual({ delivered: "resumes" });
    expect(messages.append).toHaveBeenCalledWith(expect.objectContaining({ createdByCallId: "call-1", createdByTurnId: "turn-1", taskId: "7", text: "Отдельно" }));
  });
});
