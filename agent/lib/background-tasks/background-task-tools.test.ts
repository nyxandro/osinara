/**
 * The tool surface of a background task's turn (#519).
 *
 * Constructs covered:
 * - The task holds a delegated child's tools of its chat plus `ask_person`: nothing that changes the family's
 *   settings or memory, starts another task, or sends into the chat.
 * - `write_file` refuses a path outside the task's folder, including one that climbs out of it.
 * - The summary turn has no tools.
 * - A correction reaches the task with a tool result, once per call; a failed call releases it.
 * - The files a final answer names inside the task's folder become the outcome's files.
 */
import { describe, expect, it, vi } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import { buildSubagentToolSurface } from "../tool-policy/mode-tool-surface.js";
import { outcomeFiles } from "./background-task-dispatcher.js";
import { backgroundTaskToolSurface, createTaskMessageInterjection } from "./background-task-tools.js";

function context(attributes: Record<string, string | string[]>) {
  const auth: SessionAuth = {
    current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" },
    initiator: null,
  };
  return { session: { auth, id: "session-1", turn: { id: "turn-1", kind: "background" as const, sequence: 1 } } };
}

const TASK = { backgroundTaskId: "7", familyId: "family-1", telegramChatType: "private" };

describe("background task tool surface", () => {
  it("holds a child's tools plus ask_person, and nothing that acts as the main agent", () => {
    const surface = backgroundTaskToolSurface(context(TASK), buildSubagentToolSurface({ environment: "private", owner: true }));
    expect(Object.keys(surface)).toContain("ask_person");
    expect(Object.keys(surface)).toContain("write_file");
    for (const name of ["background_task", "remember", "agent", "send_voice_message", "send_poll", "manage_reminder", "owner_settings"]) {
      expect(Object.keys(surface)).not.toContain(name);
    }
  });

  it("has no tools in the summary turn", () => {
    expect(backgroundTaskToolSurface(context({ ...TASK, backgroundTaskSummary: "true" }), buildSubagentToolSurface({ environment: "private", owner: true }))).toEqual({});
  });

  it("refuses to write outside the task's folder", async () => {
    const surface = backgroundTaskToolSurface(context(TASK), buildSubagentToolSurface({ environment: "private", owner: true }));
    const ctx = { ...context(TASK), abortSignal: new AbortController().signal, callId: "c1", toolName: "write_file" } as never;
    for (const filePath of ["/workspace/personal/notes.md", "/workspace/personal/background/7/../notes.md", "relative.md", "/workspace/personal/background/70/x.md"]) {
      await expect(surface.write_file!.execute({ content: "x", filePath }, ctx)).rejects.toThrow("AGENT_BACKGROUND_TASK_WRITE_OUTSIDE_FOLDER");
    }
    // Inside the folder the runtime's own write runs (and here fails only for want of a sandbox).
    await expect(surface.write_file!.execute({ content: "x", filePath: "/workspace/personal/background/7/table.csv" }, ctx))
      .rejects.not.toThrow("AGENT_BACKGROUND_TASK_WRITE_OUTSIDE_FOLDER");
  });

  it("puts a family group's task folder into the family's files", async () => {
    const family = { ...TASK, groupId: "group-1", groupType: "family_private" };
    const surface = backgroundTaskToolSurface(context(family), buildSubagentToolSurface({ environment: "family" }));
    expect(surface.write_file!.description).toContain("/workspace/family/background/7/");
  });
});

describe("corrections for a running task", () => {
  it("shows the waiting corrections with the call's result, and releases them when the call failed", async () => {
    const repository = {
      claimForCall: vi.fn().mockResolvedValue([{ id: "1", text: "Только 2025 год" }]),
      releaseCall: vi.fn().mockResolvedValue(undefined),
    };
    const interjection = createTaskMessageInterjection(repository);
    const ctx = { ...context(TASK), callId: "c1" } as never;
    expect(await interjection.collect(ctx)).toContain("Только 2025 год");
    expect(repository.claimForCall).toHaveBeenCalledWith("7", { callId: "c1", turnId: "turn-1" });
    await interjection.release(ctx);
    expect(repository.releaseCall).toHaveBeenCalledWith("7", { callId: "c1", turnId: "turn-1" });
    expect(await interjection.collect({ ...context({ telegramChatId: "42" }), callId: "c1" } as never)).toBeNull();
  });
});

describe("outcome files", () => {
  it("takes the files the answer names inside the task's folder, once each", () => {
    const text = "Таблица: /workspace/personal/background/7/сроки.csv. Также /workspace/personal/background/7/сроки.csv и /workspace/personal/other.csv, /workspace/family/background/8/x.csv";
    expect(outcomeFiles(text, "7")).toEqual(["/workspace/personal/background/7/сроки.csv"]);
  });
});
