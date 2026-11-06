/**
 * The tools a private question's turn keeps from its group's surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../database.js", () => ({ database: () => ({ query }) }));

import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { privateQuestionToolSurface } from "./private-question-tool-surface.js";

type AnyTool = ToolDefinition<any, any>;

function tool(name: string, execute: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ({ ok: name }))): AnyTool {
  return defineTool({ description: name, execute, inputSchema: z.looseObject({}) }) as unknown as AnyTool;
}

const GROUP_SURFACE_NAMES = [
  "agent", "bash", "execute_google_workspace", "get_current_time", "glob", "grep", "import_telegram_attachment",
  "list_group_history", "load_skill", "manage_behavior_preference", "manage_memory", "manage_memory_thread",
  "manage_reminder", "read_file", "read_profile_view", "remember", "remove_group_file", "search_memories",
  "send_contact", "send_location", "send_poll", "send_voice_message", "todo", "web_fetch", "web_search", "write_file",
];

function context(groupType: "external" | "family_private"): ToolContext {
  return {
    callId: "call-1",
    session: { auth: { current: { attributes: {
      familyId: "family", groupId: "group", groupType, privateQuestionSenderName: "Ирина", telegramUserId: "111",
    } } } },
  } as unknown as ToolContext;
}

beforeEach(() => query.mockReset());

describe("privateQuestionToolSurface", () => {
  it("keeps reading, the web and reminders, and drops everything that writes, sends or runs", () => {
    const surface = privateQuestionToolSurface(Object.fromEntries(GROUP_SURFACE_NAMES.map((name) => [name, tool(name)])));
    expect(Object.keys(surface).sort()).toEqual([
      "get_current_time", "list_group_history", "load_skill", "manage_memory", "manage_memory_thread", "manage_reminder",
      "read_profile_view", "search_memories", "todo", "web_fetch", "web_search",
    ]);
  });

  it("offers memory only for reading", async () => {
    const surface = privateQuestionToolSurface({ manage_memory: tool("manage_memory") });
    await expect(surface.manage_memory!.execute({ action: "delete", id: "x" }, context("family_private")))
      .rejects.toThrow();
  });

  it("lets the asker change their own reminder and refuses someone else's", async () => {
    const execute = vi.fn(async () => ({ id: "r-1" }));
    const surface = privateQuestionToolSurface({ manage_reminder: tool("manage_reminder", execute) });
    query.mockResolvedValueOnce({ rows: [{ author_telegram_user_id: "111", author_user_id: null }] });
    await surface.manage_reminder!.execute({ action: "delete", id: "r-1" }, context("external"));
    expect(execute).toHaveBeenCalledTimes(1);

    query.mockResolvedValueOnce({ rows: [{ author_telegram_user_id: "222", author_user_id: null }] });
    await expect(surface.manage_reminder!.execute({ action: "pause", id: "r-2" }, context("external")))
      .rejects.toMatchObject({ code: "AGENT_PRIVATE_REMINDER_NOT_OWN" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks the asker on a reminder it creates", async () => {
    const execute = vi.fn(async () => ({ id: "r-9" }));
    const surface = privateQuestionToolSurface({ manage_reminder: tool("manage_reminder", execute) });
    query.mockResolvedValue({ rows: [] });
    await surface.manage_reminder!.execute({ action: "create", content: "Пора" }, context("external"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE reminders SET mention_telegram_user_id"), ["111", "Ирина", "r-9", "group"]);
  });

  it("never sets a reminder that would wait for a timezone and ask for it in a private chat", async () => {
    const execute = vi.fn(async () => ({ id: "r-1" }));
    const surface = privateQuestionToolSurface({ manage_reminder: tool("manage_reminder", execute) });
    await expect(surface.manage_reminder!.execute({ action: "create", localFirstRun: "2026-11-07T15:00", scope: "family" }, context("family_private")))
      .rejects.toMatchObject({ code: "AGENT_PRIVATE_REMINDER_EXACT_TIME_REQUIRED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never sets a personal reminder from a family group's private question", async () => {
    const execute = vi.fn(async () => ({ id: "r-1" }));
    const surface = privateQuestionToolSurface({ manage_reminder: tool("manage_reminder", execute) });
    await expect(surface.manage_reminder!.execute({ action: "create", scope: "personal" }, context("family_private")))
      .rejects.toMatchObject({ code: "AGENT_PRIVATE_REMINDER_CHAT_ONLY" });
    expect(execute).not.toHaveBeenCalled();
  });
});
