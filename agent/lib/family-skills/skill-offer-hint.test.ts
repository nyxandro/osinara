/**
 * The previous-task hint from the turn journal.
 *
 * Constructs covered:
 * - `previousTaskStepsHint`: four working calls of a completed private turn give one line naming
 *   them; service calls do not count; a failed turn, a turn that worked with skills, a group, a
 *   schedule or a delegated task give none; a resumed turn counts its parked part too.
 */
import { describe, expect, it } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import { previousTaskStepsHint } from "./skill-offer-hint.js";

type Call = { readonly skill?: string; readonly tool_name: string; readonly turn: string };

function journal(previous: { id: string; resumes_turn_id?: string | null; status: string } | undefined, calls: readonly Call[]) {
  const seen: unknown[][] = [];
  return {
    seen,
    database: {
      async query(sql: string, values: unknown[]) {
        seen.push(values);
        if (sql.includes("FROM agent_turns")) return { rows: previous === undefined ? [] : [{ resumes_turn_id: null, ...previous }] };
        const turns = values[0] as string[];
        return { rows: calls.filter((call) => turns.includes(call.turn)).map((call) => ({ skill: call.skill ?? null, tool_name: call.tool_name })) };
      },
    } as never,
  };
}

function auth(chat: "group" | "private"): SessionAuth {
  const caller = {
    attributes: {
      familyId: "family-1", memoryScopes: chat === "private" ? ["personal", "family"] : ["family"],
      ...(chat === "group" ? { groupId: "group-1", groupType: "family_private" } : {}),
      telegramActorId: "101", telegramActorKind: "telegram_user", telegramChatType: chat === "private" ? "private" : "group", telegramUserId: "101",
    },
    authenticator: "telegram", principalId: "user-1", principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

const ctx = (chat: "group" | "private" = "private", kind?: string) => ({ channel: { kind }, session: { auth: auth(chat), id: "wrun-1" }, turnId: "turn-2" });
const steps = (turn: string, ...tools: string[]): Call[] => tools.map((tool_name) => ({ tool_name, turn }));

describe("previous task steps hint", () => {
  it("names the working tools of a long completed task", async () => {
    const { database } = journal({ id: "turn-1", status: "completed" },
      steps("turn-1", "bash", "todo", "web_fetch", "bash", "load_skill", "read_file", "remember"));

    await expect(previousTaskStepsHint(database, ctx(), { scheduledRun: false })).resolves
      .toBe("<previous_task_steps>The previous task in this conversation took 4 tool steps: bash, web_fetch, read_file.</previous_task_steps>");
  });

  it("stays silent for a short task, a failed one, or one that already worked with skills", async () => {
    const short = journal({ id: "turn-1", status: "completed" }, steps("turn-1", "bash", "bash", "web_fetch", "todo"));
    const failed = journal({ id: "turn-1", status: "failed" }, steps("turn-1", "bash", "bash", "bash", "bash"));
    const managed = journal({ id: "turn-1", status: "completed" }, steps("turn-1", "bash", "bash", "bash", "bash", "manage_skill"));
    const family = journal({ id: "turn-1", status: "completed" },
      [...steps("turn-1", "bash", "bash", "bash", "bash"), { skill: "doc-signing", tool_name: "load_skill", turn: "turn-1" }]);
    const builtIn = journal({ id: "turn-1", status: "completed" },
      [...steps("turn-1", "bash", "bash", "bash", "bash"), { skill: "pdf", tool_name: "load_skill", turn: "turn-1" }]);

    for (const { database } of [short, failed, managed, family]) {
      await expect(previousTaskStepsHint(database, ctx(), { scheduledRun: false })).resolves.toBeNull();
    }
    await expect(previousTaskStepsHint(builtIn.database, ctx(), { scheduledRun: false })).resolves.toContain("took 4 tool steps");
    await expect(previousTaskStepsHint(journal(undefined, []).database, ctx(), { scheduledRun: false })).resolves.toBeNull();
  });

  it("counts the parked part of a task resumed after a confirmation", async () => {
    const { database } = journal({ id: "turn-1b", resumes_turn_id: "turn-1a", status: "completed" },
      [...steps("turn-1a", "bash", "web_fetch"), ...steps("turn-1b", "bash", "send_workspace_file")]);

    await expect(previousTaskStepsHint(database, ctx(), { scheduledRun: false })).resolves.toContain("took 4 tool steps");
  });

  it("gives nothing outside a person's own live conversation", async () => {
    const { database, seen } = journal({ id: "turn-1", status: "completed" }, steps("turn-1", "bash", "bash", "bash", "bash"));

    await expect(previousTaskStepsHint(database, ctx("group"), { scheduledRun: false })).resolves.toBeNull();
    await expect(previousTaskStepsHint(database, ctx(), { scheduledRun: true })).resolves.toBeNull();
    await expect(previousTaskStepsHint(database, ctx("private", "subagent"), { scheduledRun: false })).resolves.toBeNull();
    expect(seen).toEqual([]);
  });
});
