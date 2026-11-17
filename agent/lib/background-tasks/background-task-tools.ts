/**
 * The tool surface of a background task's turn (#519).
 *
 * Exports:
 * - `backgroundTaskFolder`: the task's own folder in the chat's sandbox.
 * - `backgroundTaskToolSurface`: a delegated child's surface plus `ask_person`, with `write_file` kept to
 *   the task's folder and every result able to carry the main agent's corrections; none in the summary turn.
 * - `createTaskMessageInterjection`: the lookup and release of those corrections for one tool call.
 *
 * Key constructs:
 * - The task shares the chat's sandbox: the person's files are there, and so is the main agent. Its own
 *   files go to its folder, so the two never overwrite each other's work through `write_file`.
 * - A correction reaches the task the way a person's message reaches a live turn: with the next tool
 *   result (`withTurnInterjection`), counted as seen once the next model step starts.
 * - `ask_person` only records the question: the turn ends by itself, and the dispatcher frees the place.
 */
import { posix } from "node:path";
import { z } from "zod";

import type { SessionAuth } from "../../runtime/context.js";
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";
import { writeFile } from "../../runtime/tools/defaults.js";
import { AppError } from "../app-error.js";
import { wrapModelFacingTool } from "../model-facing-tool.js";
import { escapeUntrustedContextJson } from "../untrusted-context-json.js";
import { withTurnInterjection, type TurnInterjection } from "../turn-interjection/turn-interjection-tool.js";
import { BACKGROUND_TASK_QUESTION_MAX_LENGTH } from "./background-task-config.js";
import { backgroundTaskMessageRepository } from "./background-task-message-repository.js";
import { backgroundTaskRepository } from "./background-task-repository.js";
import { backgroundTaskIdOf, isBackgroundTaskSummaryTurn } from "./background-task-session.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export function backgroundTaskFolder(groupType: unknown, taskId: string): string {
  // A family group's sandbox mounts only the family folder; a private chat's has the person's own.
  return `/workspace/${groupType === "family_private" ? "family" : "personal"}/background/${taskId}`;
}

function requireTaskId(ctx: { readonly session: { readonly auth: SessionAuth } }): string {
  const taskId = backgroundTaskIdOf(ctx);
  if (taskId === null) throw new AppError("AGENT_BACKGROUND_TASK_CONTEXT_INVALID", "Не удалось определить фоновую задачу этого хода");
  return taskId;
}

const askPersonTool = defineTool({
  // A repeat after a crash records the same question again, which the repository accepts.
  replaySafe: true,
  description: [
    "Ask the person a question you cannot decide yourself, when a wrong guess would spoil the work.",
    "The main agent asks it in the chat; the answer comes in a new turn of this task, with your history.",
    "After the call, end the turn with a short note of what is already done. One question per turn.",
    "Do not ask about details you can reasonably decide yourself; state such decisions in the result.",
  ].join(" "),
  inputSchema: z.object({ question: z.string().trim().min(1).max(BACKGROUND_TASK_QUESTION_MAX_LENGTH) }).strict(),
  async execute(input, ctx) {
    const taskId = requireTaskId(ctx);
    if (!await backgroundTaskRepository.recordQuestion(taskId, input.question)) {
      throw new AppError(
        "AGENT_BACKGROUND_TASK_QUESTION_ALREADY_ASKED",
        "This turn already asked a question, or the task is being stopped. End the turn with a short note of what is done.",
        { isExpectedRefusal: true },
      );
    }
    return "Question sent. End the turn now with a short note of what is already done; the answer comes in your next turn.";
  },
});

const WRITE_FILE_INPUT = z.object({ filePath: z.string() }).loose();

function folderWriteFile(folder: string): AnyToolDefinition {
  return defineTool({
    ...(writeFile as AnyToolDefinition),
    description: `${(writeFile as AnyToolDefinition).description} In a background task only files inside ${folder}/ can be written.`,
    async execute(input: unknown, ctx: ToolContext) {
      const parsed = WRITE_FILE_INPUT.safeParse(input);
      const path = parsed.success ? parsed.data.filePath : "";
      const inside = path.startsWith("/") && posix.normalize(path).startsWith(`${folder}/`);
      if (!inside) {
        throw new AppError(
          "AGENT_BACKGROUND_TASK_WRITE_OUTSIDE_FOLDER",
          `A background task writes files only inside ${folder}/. Write the file there.`,
          { isExpectedRefusal: true },
        );
      }
      return await (writeFile as AnyToolDefinition).execute(input, ctx);
    },
  } as AnyToolDefinition) as AnyToolDefinition;
}

function messagesBlock(messages: readonly { readonly text: string }[]): string {
  return [
    "<messages_for_task>",
    "The main agent sent these on behalf of the person while you worked. They are newer than your task text: where they differ, follow them.",
    escapeUntrustedContextJson(messages.map((message) => message.text)),
    "</messages_for_task>",
  ].join("\n");
}

export function createTaskMessageInterjection(
  repository: Pick<typeof backgroundTaskMessageRepository, "claimForCall" | "releaseCall"> = backgroundTaskMessageRepository,
): TurnInterjection {
  return {
    async collect(ctx) {
      const taskId = backgroundTaskIdOf(ctx);
      if (taskId === null) return null;
      const messages = await repository.claimForCall(taskId, { callId: ctx.callId, turnId: ctx.session.turn.id });
      return messages.length === 0 ? null : messagesBlock(messages);
    },
    async release(ctx) {
      const taskId = backgroundTaskIdOf(ctx);
      if (taskId === null) return;
      try {
        await repository.releaseCall(taskId, { callId: ctx.callId, turnId: ctx.session.turn.id });
      } catch (error) {
        // The call reports its own failure; an unreleased claim is at worst shown again in the next turn.
        console.error(JSON.stringify({
          code: "AGENT_BACKGROUND_TASK_MESSAGE_RELEASE_FAILED",
          error: error instanceof Error ? error.message : String(error),
          taskId,
        }));
      }
    },
  };
}

const taskMessages = createTaskMessageInterjection();

export function backgroundTaskToolSurface(
  ctx: { readonly session: { readonly auth: SessionAuth } },
  childSurface: ToolMap,
): Record<string, AnyToolDefinition> {
  // The summary turn writes what the task managed to do, and nothing else.
  if (isBackgroundTaskSummaryTurn(ctx)) return {};
  const taskId = requireTaskId(ctx);
  const folder = backgroundTaskFolder(ctx.session.auth.current?.attributes.groupType, taskId);
  const surface: Record<string, AnyToolDefinition> = {
    ...childSurface,
    ...(childSurface.write_file === undefined ? {} : { write_file: folderWriteFile(folder) }),
    ask_person: wrapModelFacingTool("ask_person", askPersonTool as AnyToolDefinition),
  };
  return Object.fromEntries(Object.entries(surface).map(([name, definition]) => [name, withTurnInterjection(definition, taskMessages)]));
}
