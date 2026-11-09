/**
 * A press in an A2UI widget, from Telegram's `widget_query` to the presser's message in the chat queue.
 *
 * Exports:
 * - `WIDGET_PRESS_UPDATE_ID_BASE`, `WIDGET_PRESS_MESSAGE_ID_BASE`: where the queue's numbers of presses begin.
 * - `WidgetPressDependencies`: what a press needs, injectable in tests.
 * - `createWidgetPressHandler`: the handler of one `widget_query` update.
 * - `widgetPressText`: what the model reads for a press.
 * - `handleWidgetQuery`: the production handler.
 *
 * Key constructs:
 * - Telegram waits 15 s for the answer, while the chat queue may wait minutes for a running turn. So
 *   the press is decided and stored first, its message is queued, and only then the widget is answered
 *   (`{"ok":1}` or `{"err":…}`); the agent's reply follows through the queue like any message.
 * - Presses come from Telegram's beta server, whose update numbers are a sequence of their own. The
 *   press is known by Telegram's query id; its message is built once and stored with it, and enters the
 *   queue under a number far above any real one, derived from the beta update number, so a redelivery
 *   enqueues exactly the same message, which the queue takes as a duplicate.
 * - The data says only which action, which revision and which marks (`widget-query-data.ts`). The
 *   action's name, label and context come from the stored widget, resolved against the data model as
 *   the person saw it, so a crafted press can say nothing a button does not.
 * - The press becomes the presser's own message: it goes through the same authorization, queue,
 *   history and memory as typed text and authorizes nothing more.
 * - Widgets work only in the private chat with the bot for now (the owner's decision of 06.11.2026);
 *   a press anywhere else is answered as closed.
 * - A widget a scenario run sent (#480) is pressed in the chat's own conversation, which did not see
 *   it sent: the press names the scenario and the moment of its run, so the agent can read what the
 *   scenario expects and tell a card of an earlier run from today's.
 * - The message follows A2UI's renderer-to-agent `action` message, so the model reads presses in the
 *   protocol it wrote the widget in.
 */
import { resolveTelegramBotToken, telegramContinuationToken } from "../../runtime/telegram/api.js";

import { AppError } from "../app-error.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import type { JsonObject, JsonValue } from "./a2ui/a2ui-types.js";
import { evaluateString, evaluateValue, WidgetEvaluationError } from "./a2ui/evaluate.js";
import type { WidgetAction } from "./a2ui/render.js";
import { parseWidgetQueryData, pressedDataModel } from "./widget-query-data.js";
import { type StoredWidget, widgetRepository, type WidgetScenario } from "./widget-repository.js";
import { type WidgetTelegram, widgetTelegram } from "./widget-telegram.js";

export const WIDGET_PRESS_UPDATE_ID_BASE = 2n ** 50n;
export const WIDGET_PRESS_MESSAGE_ID_BASE = 2n ** 41n;
const QUOTE_MAX_CHARACTERS = 300;

export interface WidgetPressDependencies {
  /** The bot's own user id: a press answering the widget's conversation replies to the bot's message. */
  readonly botUserId: () => Promise<string>;
  readonly enqueue: (input: { readonly continuationKey: string; readonly payload: JsonObject; readonly updateId: string }) => Promise<unknown>;
  readonly continuationKey: (input: { readonly chatId: string; readonly conversationId?: string }) => string;
  readonly replyRouteIsOpen: (baseContinuationToken: string) => Promise<boolean>;
  readonly repository: Pick<typeof widgetRepository, "claimQuery" | "findByMessage" | "scenarioOf" | "storePressPayload">;
  readonly telegram: Pick<WidgetTelegram, "answerQuery">;
}

interface WidgetQuery {
  readonly chat: Record<string, unknown> & { readonly id: number | string; readonly type: string };
  readonly data: string;
  readonly from: Record<string, unknown> & { readonly id: number | string };
  readonly id: string;
  readonly messageId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readQuery(raw: JsonObject): { betaUpdateId: bigint; query: WidgetQuery } | null {
  const updateId = raw.update_id;
  const query = record(raw.widget_query);
  const chat = record(query?.chat);
  const from = record(query?.from);
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId <= 0 || query === null || chat === null || from === null) return null;
  if (typeof query.id !== "string" || typeof query.data !== "string" || typeof query.message_id !== "number") return null;
  if ((typeof chat.id !== "number" && typeof chat.id !== "string") || typeof chat.type !== "string") return null;
  if (typeof from.id !== "number" && typeof from.id !== "string") return null;
  return {
    betaUpdateId: BigInt(updateId),
    query: { chat: chat as WidgetQuery["chat"], data: query.data, from: from as WidgetQuery["from"], id: query.id, messageId: String(query.message_id) },
  };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= QUOTE_MAX_CHARACTERS ? flat : `${characters.slice(0, QUOTE_MAX_CHARACTERS).join("").trimEnd()}…`;
}

/** What the model reads as the person's message: the pressed button, the widget and A2UI's action. */
export function widgetPressText(input: {
  readonly action: JsonObject;
  readonly caption: string;
  readonly label: string;
  readonly scenario?: WidgetScenario | null;
  readonly stale: string | null;
}): string {
  const stale = input.stale === null ? "" : ` ${input.stale}`;
  const scenario = input.scenario === undefined || input.scenario === null
    ? ""
    : ` sent by your scheduled scenario «${oneLine(input.scenario.title)}» (schedule_id ${input.scenario.id}, run of ${input.scenario.scheduledForLocal} local time); read it with manage_agent_schedule list to see what this press means`;
  return `[Pressed «${oneLine(input.label)}» in your widget «${oneLine(input.caption)}»${scenario}]${stale}\n${JSON.stringify({ action: input.action, version: "1.0" })}`;
}

function a2uiAction(widget: StoredWidget, action: WidgetAction, dataModel: JsonObject, score: number | null): JsonObject {
  const scope = { dataModel, item: action.item, reads: new Set<string>() };
  const context: Record<string, JsonValue> = {};
  if (action.quiz) {
    context.score = score ?? 0;
    context.total = action.total ?? 0;
  }
  for (const [key, value] of Object.entries(action.context ?? {})) context[key] = evaluateValue(value, scope, `/context/${key}`);
  const userMessage = action.userMessage === null ? null : evaluateString(action.userMessage, scope, "/userMessage");
  return {
    context,
    name: action.name,
    sourceComponentId: action.sourceComponentId,
    surfaceId: widget.surfaceId,
    timestamp: new Date().toISOString(),
    ...(userMessage === null ? {} : { userMessage }),
    ...(widget.surface.sendDataModel ? { metadata: { dataModel } } : {}),
  };
}

export function createWidgetPressHandler(dependencies: WidgetPressDependencies) {
  async function answer(widgetQueryId: string, data: Record<string, unknown>): Promise<void> {
    try {
      await dependencies.telegram.answerQuery({ data: JSON.stringify(data), widgetQueryId });
    } catch (error) {
      // The answer only lets the widget show the outcome; what was decided and queued stands without it.
      console.error(JSON.stringify({
        code: "AGENT_WIDGET_QUERY_ANSWER_FAILED",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
      }));
    }
  }

  async function message(widget: StoredWidget, query: WidgetQuery, betaUpdateId: bigint, actionIndex: number, bits: string, revision: number, score: number | null) {
    const action = widget.surface.actions[actionIndex]!;
    const dataModel = pressedDataModel(widget.dataModel, widget.surface.slots, bits);
    const a2ui = a2uiAction(widget, action, dataModel, score);
    const stale = revision < widget.revision ? `(pressed while the widget showed revision ${revision}; it is now ${widget.revision})` : null;
    const chatId = String(query.chat.id);
    const reply = await dependencies.replyRouteIsOpen(dependencies.continuationKey({ chatId, conversationId: widget.telegramMessageId }));
    return {
      chat: query.chat,
      date: Math.floor(Date.now() / 1_000),
      from: query.from,
      message_id: Number(WIDGET_PRESS_MESSAGE_ID_BASE + betaUpdateId),
      text: widgetPressText({ action: a2ui, caption: widget.caption, label: action.label, scenario: await dependencies.repository.scenarioOf(widget.id), stale }),
      ...(reply ? { reply_to_message: { chat: query.chat, from: { first_name: "bot", id: Number(await dependencies.botUserId()), is_bot: true }, message_id: Number(widget.telegramMessageId) } } : {}),
    };
  }

  return async function handleWidgetQuery(raw: JsonObject): Promise<void> {
    const parsed = readQuery(raw);
    if (parsed === null) {
      console.error(JSON.stringify({ code: "AGENT_WIDGET_QUERY_INVALID", reason: "shape" }));
      return;
    }
    const { betaUpdateId, query } = parsed;
    const chatId = String(query.chat.id);
    if (query.chat.type !== "private") {
      await answer(query.id, { err: "closed" });
      return;
    }
    const known = await dependencies.repository.findByMessage(chatId, query.messageId);
    const press = known === null ? null : parseWidgetQueryData(query.data, known.surface.slots.length);
    const ingressUpdateId = String(WIDGET_PRESS_UPDATE_ID_BASE + betaUpdateId);
    const started = Date.now();
    const claim = await dependencies.repository.claimQuery({
      actionIndex: press?.actionIndex ?? null,
      betaUpdateId: String(betaUpdateId),
      ingressUpdateId,
      revision: press?.revision ?? null,
      telegramChatId: chatId,
      telegramMessageId: query.messageId,
      telegramUserId: String(query.from.id),
      widgetQueryId: query.id,
    });
    if (claim.status !== "accepted" && claim.status !== "replayed") {
      console.info(JSON.stringify({ code: "AGENT_WIDGET_QUERY", decision: claim.status, ms: Date.now() - started }));
      await answer(query.id, { err: claim.status.replace("refused_", "") });
      return;
    }
    let payload = claim.payload;
    if (payload === null) {
      let built: Record<string, unknown>;
      try {
        built = await message(claim.widget, query, betaUpdateId, press!.actionIndex, press!.bits, press!.revision, press!.score);
      } catch (error) {
        if (!(error instanceof WidgetEvaluationError)) throw error;
        // The stored widget resolved once when it was built; a context that no longer resolves is a bug to see.
        console.error(JSON.stringify({ code: "AGENT_WIDGET_PRESS_CONTEXT_FAILED", error: error.message, field: error.field }));
        await answer(query.id, { err: "invalid" });
        return;
      }
      payload = await dependencies.repository.storePressPayload(query.id, { message: built as JsonObject, update_id: Number(claim.ingressUpdateId) });
    }
    await dependencies.enqueue({ continuationKey: dependencies.continuationKey({ chatId }), payload, updateId: claim.ingressUpdateId });
    console.info(JSON.stringify({ code: "AGENT_WIDGET_QUERY", decision: claim.status, ms: Date.now() - started }));
    await answer(query.id, { ok: 1 });
  };
}

export const handleWidgetQuery = createWidgetPressHandler({
  botUserId: async () => (await resolveTelegramBotToken(process.env.TELEGRAM_BOT_TOKEN)).split(":")[0]!,
  continuationKey: telegramContinuationToken,
  enqueue: (input) => telegramIngressRepository.enqueue(input),
  replyRouteIsOpen: (token) => replyButtonRepository.replyRouteIsOpen(token),
  repository: widgetRepository,
  telegram: widgetTelegram,
});
