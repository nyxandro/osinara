/**
 * The tools of a private question's turn: reading the chat, the web and the person's own reminders (#467).
 *
 * Exports:
 * - `PRIVATE_QUESTION_TOOL_NAMES`: the tools a private turn keeps from its group's surface, as they are.
 * - `privateQuestionToolSurface`: narrows the group's surface to reading and reminders.
 *
 * Key constructs:
 * - Built from the surface the group would get for an ordinary turn, so a right the group lacks is lacking
 *   here too, and a right revoked mid-turn leaves the next step.
 * - Memory and threads are offered as reading views only. No file, command, skill, delegation, Google,
 *   voice, place, poll, memory write or note change: what the shared chat holds is changed only aloud.
 * - Reminders stay, because a reminder is meant to be public (owner's decision, 2026-11-06); a private turn
 *   changes, pauses or removes only reminders its asker set, so nobody can quietly cancel someone else's.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { wrapModelFacingTool } from "../model-facing-tool.js";
import manageMemory, { manageMemoryPresentation } from "../tools/manage_memory.js";
import manageMemoryThread, {
  manageMemoryThreadPresentation,
  MEMORY_THREAD_READING_ACTIONS,
} from "../tools/manage_memory_thread.js";
import { actionView } from "../tool-policy/action-view.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS } from "../tool-policy/external-group-memory-tools.js";
import { resolveExternalGroupPolicyIdentity } from "../tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";

type AnyTool = ToolDefinition<any, any>;

export const PRIVATE_QUESTION_TOOL_NAMES = Object.freeze([
  "get_current_time",
  "list_group_history",
  // Only service skills come with the tools of the turn (no group skills): the reminders' how-to among them.
  "load_skill",
  "read_profile_view",
  "search_memories",
  "todo",
  "web_fetch",
  "web_search",
] as const);

const REMINDER_CHANGING_ACTIONS = new Set(["update", "pause", "resume", "delete"]);

function attributes(ctx: ToolContext): Record<string, unknown> {
  return (ctx.session.auth.current?.attributes ?? {}) as Record<string, unknown>;
}

/** An external group's right is checked live, as in its ordinary turns; a family group has no per-right list. */
async function authorizeRead(ctx: ToolContext, capability: ExternalGroupToolName): Promise<void> {
  if (attributes(ctx).groupType !== "external") return;
  const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
  if (identity === null) {
    throw new AppError("AGENT_PRIVATE_QUESTION_GROUP_POLICY_MISSING", "Не удалось проверить права этой группы");
  }
  await authorizeCurrentExternalGroupCapability(identity, capability);
}

/** Who set a reminder of this chat: its account in a family group, its Telegram user elsewhere. */
async function requireOwnReminder(ctx: ToolContext, reminderId: unknown): Promise<void> {
  const attrs = attributes(ctx);
  // A reminder still waiting for its author's timezone is changed through the same tool, so it is checked too.
  const result = await database().query<{ author_telegram_user_id: string | null; author_user_id: string | null }>(
    `SELECT reminder.author_telegram_user_id,
            (SELECT users.telegram_user_id FROM users WHERE users.id = reminder.author_user_id) AS author_user_id
       FROM reminders AS reminder WHERE reminder.id::text = $1 AND reminder.group_id = $2
     UNION ALL
     SELECT NULL, (SELECT users.telegram_user_id FROM users WHERE users.id = wait.author_user_id)
       FROM reminder_timezone_waits AS wait WHERE wait.id::text = $1 AND wait.group_id = $2`,
    [String(reminderId), attrs.groupId],
  );
  const row = result.rows[0];
  // A reminder of another chat or one that does not exist is the tool's own "not found" to report.
  if (!row) return;
  const author = row.author_telegram_user_id ?? row.author_user_id;
  if (author !== attrs.telegramUserId) {
    throw new AppError(
      "AGENT_PRIVATE_REMINDER_NOT_OWN",
      "Лично можно менять только свои напоминания. Чужое — пусть попросят вслух",
    );
  }
}

/**
 * The reminder goes to the general chat at its time: it marks the person who asked privately, so they are
 * notified and the others see whom it is for. Repeating it after a replayed call writes the same values.
 */
async function markReminderForAsker(ctx: ToolContext, result: unknown): Promise<void> {
  const id = typeof result === "object" && result !== null ? (result as { id?: unknown }).id : undefined;
  // A reminder still waiting for a timezone has no reminder row yet; it is delivered without the mark.
  if (typeof id !== "string") return;
  const attrs = attributes(ctx);
  await database().query(
    `UPDATE reminders SET mention_telegram_user_id = $1, mention_name = $2
      WHERE id::text = $3 AND group_id = $4 AND scope IN ('group', 'family')`,
    [attrs.telegramUserId, attrs.privateQuestionSenderName, id, attrs.groupId],
  );
}

function ownRemindersOnly(definition: AnyTool): AnyTool {
  return defineTool({
    ...definition,
    async execute(input: unknown, ctx: ToolContext) {
      const call = (typeof input === "object" && input !== null ? input : {}) as {
        action?: unknown; id?: unknown; localFirstRun?: unknown; scope?: unknown;
      };
      // A family group's tool can also set a personal reminder, delivered in a private chat: never from here.
      if (call.action === "create" && attributes(ctx).groupType === "family_private" && call.scope !== "family") {
        throw new AppError(
          "AGENT_PRIVATE_REMINDER_CHAT_ONLY",
          "Из личного вопроса ставится только напоминание этого чата: scope family. Оно придёт сюда с отметкой человека",
        );
      }
      // A local time waits for the author's timezone, and the application then asks for it in a private chat:
      // a private question sends nothing to anyone's private chat, so it sets reminders at an exact time only.
      if (call.action === "create" && call.localFirstRun !== undefined) {
        throw new AppError(
          "AGENT_PRIVATE_REMINDER_EXACT_TIME_REQUIRED",
          "Из личного вопроса напоминание ставится только на точное время с часовым поясом (firstRunAt) или через firstRunInMinutes. " +
            "Если часовой пояс человека неизвестен, предложи поставить напоминание вслух в чате",
        );
      }
      if (REMINDER_CHANGING_ACTIONS.has(String(call.action))) await requireOwnReminder(ctx, call.id);
      const result = await definition.execute(input, ctx);
      if (call.action === "create") await markReminderForAsker(ctx, result);
      return result;
    },
  }) as unknown as AnyTool;
}

export function privateQuestionToolSurface(groupSurface: Readonly<Record<string, AnyTool>>): Record<string, AnyTool> {
  const surface: Record<string, AnyTool> = {};
  for (const name of PRIVATE_QUESTION_TOOL_NAMES) {
    const tool = groupSurface[name];
    if (tool !== undefined) surface[name] = tool;
  }
  if (groupSurface.manage_memory !== undefined) {
    surface.manage_memory = wrapModelFacingTool("manage_memory", actionView({
      actions: ["list"],
      authorize: async (ctx) => await authorizeRead(ctx, "list_memories"),
      definition: manageMemory as unknown as AnyTool,
      presentation: manageMemoryPresentation(["list"]),
      toolName: "manage_memory",
    }));
  }
  if (groupSurface.manage_memory_thread !== undefined) {
    surface.manage_memory_thread = wrapModelFacingTool("manage_memory_thread", actionView({
      actions: MEMORY_THREAD_READING_ACTIONS,
      authorize: async (ctx, action) => await authorizeRead(ctx, EXTERNAL_MEMORY_THREAD_ACTION_RIGHTS[action]),
      definition: manageMemoryThread as unknown as AnyTool,
      presentation: manageMemoryThreadPresentation([...MEMORY_THREAD_READING_ACTIONS]),
      toolName: "manage_memory_thread",
    }));
  }
  if (groupSurface.manage_reminder !== undefined) surface.manage_reminder = ownRemindersOnly(groupSurface.manage_reminder);
  return surface;
}
