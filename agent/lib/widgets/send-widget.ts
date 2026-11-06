/**
 * Sending one widget to the current chat: an A2UI surface the application builds, or the model's own HTML.
 *
 * Exports:
 * - `SendWidgetInput`: the tool's checked input.
 * - `SendWidgetDependencies`: what sending needs, injectable in tests.
 * - `sendWidget`: the whole send, returning what the model reads.
 * - `WIDGET_TOOL_CODES`: the tool's codes shared with its definition.
 *
 * Key constructs:
 * - An A2UI surface is validated, built and stored; its presses can reach the agent, so it is sent with
 *   `allow_queries` when it has an action. The model's own HTML (a game, F6 B of #468) passes the quick
 *   check and Telegram's official check and is sent without `allow_queries`: it never talks to the bot.
 * - Every refusal before sending is an input error with all problems at once, so the model fixes them
 *   in one more call; after that the model answers in text (`telegram-send-errors.ts`).
 * - A widget Telegram confirmed is never sent again: a failure to store it is logged and leaves a
 *   widget that cannot be updated or pressed, which the result says.
 * - Logs carry sizes and codes, never the widget's content or caption: they may hold personal data.
 */
import type { ToolContext } from "../../runtime/tool.js";

import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { telegramSendInputError } from "../telegram-sends/telegram-send-errors.js";
import type { sendTelegramNativeMessage } from "../telegram-sends/telegram-native-send.js";
import type { recordToolDeliveryInTimeline, ToolDeliveryTimelineTarget } from "../telegram-tool-delivery-timeline.js";
import type { A2uiError } from "./a2ui/a2ui-types.js";
import { renderWidget } from "./a2ui/render.js";
import { validateCreateSurface } from "./a2ui/validate-surface.js";
import type { OfficialCheck } from "./html/official-check.js";
import { preflightHtmlWidget, type HtmlFinding } from "./html/html-preflight.js";
import { withTelegramLinkGuard } from "./html/telegram-link-guard.js";
import {
  TELEGRAM_WIDGET_API_BASE_URL,
  TELEGRAM_WIDGET_COMPRESSED_LIMIT,
  WIDGET_COMPRESSED_MAX_BYTES,
  WIDGET_HTML_MAX_BYTES,
} from "./widget-config.js";
import type { widgetRepository } from "./widget-repository.js";

export const WIDGET_TOOL_CODES = {
  ambiguous: "AGENT_WIDGET_DELIVERY_AMBIGUOUS",
  failed: "AGENT_WIDGET_DELIVERY_FAILED",
  htmlRefused: "AGENT_WIDGET_HTML_REFUSED",
  invalid: "AGENT_WIDGET_INPUT_INVALID",
  surfaceInvalid: "AGENT_WIDGET_SURFACE_INVALID",
  tooLarge: "AGENT_WIDGET_TOO_LARGE",
} as const;

export interface SendWidgetInput {
  readonly caption: string;
  readonly height?: number;
  readonly html?: string;
  readonly surface?: unknown;
}

export interface SendWidgetDependencies {
  readonly check: OfficialCheck;
  readonly recordTimeline: typeof recordToolDeliveryInTimeline;
  readonly repository: Pick<typeof widgetRepository, "save" | "surfaceIdTaken">;
  readonly send: typeof sendTelegramNativeMessage;
}

interface Delivery {
  readonly chatId: string;
  readonly replyToMessageId: number | undefined;
  readonly timelineTarget: ToolDeliveryTimelineTarget;
}

const ONE_MORE_CALL = "Исправь всё перечисленное и вызови send_widget ещё раз один раз; если снова не выйдет, ответь обычным текстом.";

function surfaceErrors(errors: readonly A2uiError[]): Error {
  return telegramSendInputError({
    code: WIDGET_TOOL_CODES.surfaceInvalid,
    correction: `Ошибки описания A2UI (code, path — указатель на поле в твоём сообщении, message): ${JSON.stringify(errors.map(({ code, message, path }) => ({ code, message, path })))}. ${ONE_MORE_CALL}`,
    reason: "Описание виджета не прошло проверку по каталогу.",
  });
}

function htmlRefused(findings: readonly HtmlFinding[]): Error {
  const tooLarge = findings.some((finding) => finding.code === "compressed_too_large" || finding.code === "html_too_large");
  return telegramSendInputError({
    code: tooLarge && findings.length === 1 ? WIDGET_TOOL_CODES.tooLarge : WIDGET_TOOL_CODES.htmlRefused,
    correction: `Проблемы виджета: ${findings.map((finding) => `${finding.code}: ${finding.hint}`).join("; ")}. ${ONE_MORE_CALL}`,
    reason: "Свой HTML-виджет не прошёл проверку.",
  });
}

function tooLarge(htmlBytes: number, compressedBytes: number): Error {
  return telegramSendInputError({
    code: WIDGET_TOOL_CODES.tooLarge,
    correction: `Собранный виджет: ${htmlBytes} байт, ${compressedBytes} байт в сжатом виде; предел ${WIDGET_HTML_MAX_BYTES} и ${WIDGET_COMPRESSED_MAX_BYTES}. Сократи: меньше строк в списках и таблицах, короче тексты, раздели на вкладки. ${ONE_MORE_CALL}`,
    reason: "Виджет больше, чем принимает Telegram.",
  });
}

async function deliver(
  dependencies: SendWidgetDependencies,
  delivery: Delivery,
  body: Record<string, string | number | boolean>,
): Promise<string> {
  try {
    const sent = await dependencies.send({
      apiBaseUrl: TELEGRAM_WIDGET_API_BASE_URL,
      body,
      codes: {
        ambiguous: WIDGET_TOOL_CODES.ambiguous,
        ambiguousMessage: "Не удалось подтвердить отправку виджета. Проверьте чат перед повторной просьбой",
        failed: WIDGET_TOOL_CODES.failed,
        failedMessage: "Telegram не принял виджет: возможно, в этом чате боту нельзя отправлять медиа",
      },
      method: "sendWidget",
      refusals: [{
        code: WIDGET_TOOL_CODES.tooLarge,
        message: `Telegram насчитал виджет больше ${TELEGRAM_WIDGET_COMPRESSED_LIMIT} байт в сжатом виде`,
        telegramError: "INPUT_MEDIA_WIDGET_TOO_LARGE",
      }],
      target: { chatId: delivery.chatId, ...(delivery.replyToMessageId === undefined ? {} : { replyToMessageId: delivery.replyToMessageId }) },
    });
    return sent.telegramMessageId;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === WIDGET_TOOL_CODES.tooLarge) {
      throw telegramSendInputError({
        code: WIDGET_TOOL_CODES.tooLarge,
        correction: `Telegram посчитал виджет больше своего предела. Сократи его ещё примерно на 10%. ${ONE_MORE_CALL}`,
        reason: "Telegram не принял виджет по размеру.",
      });
    }
    throw error;
  }
}

function nextStep(actions: readonly string[], surfaceId: string | null): string {
  const base = `Виджет уже в чате и стал частью твоего ответа. Если он отвечает на просьбу целиком, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста; если нужны слова, напиши только то, чего в виджете нет, и не пересказывай его.`;
  if (surfaceId === null) return base;
  const presses = actions.length === 0
    ? ""
    : ` Нажатия кнопок ${actions.join(", ")} придут тебе следующими сообщениями человека с данными действия.`;
  return `${base}${presses} Чтобы изменить показанные значения, вызови update_widget с surfaceId «${surfaceId}».`;
}

async function sendSurface(dependencies: SendWidgetDependencies, input: SendWidgetInput, ctx: ToolContext, delivery: Delivery) {
  const validated = validateCreateSurface(input.surface);
  if (!validated.ok) throw surfaceErrors(validated.errors);
  const { surface } = validated;
  if (await dependencies.repository.surfaceIdTaken(delivery.chatId, surface.surfaceId)) {
    throw surfaceErrors([{ code: "INTEGRITY_ERROR", message: `surfaceId "${surface.surfaceId}" was already used in this chat: give every widget a new one`, path: "/createSurface/surfaceId", surfaceId: surface.surfaceId }]);
  }
  const rendered = renderWidget(surface);
  if (!rendered.ok) throw surfaceErrors(rendered.errors);
  const widget = rendered.widget;
  if (widget.htmlBytes > WIDGET_HTML_MAX_BYTES || widget.compressedBytes > WIDGET_COMPRESSED_MAX_BYTES) throw tooLarge(widget.htmlBytes, widget.compressedBytes);
  const telegramMessageId = await deliver(dependencies, delivery, {
    caption: input.caption,
    html: widget.html,
    ...(widget.actions.length > 0 ? { allow_queries: true } : {}),
  });
  console.info(JSON.stringify({ actions: widget.actions.length, code: "AGENT_WIDGET_SENT", compressedBytes: widget.compressedBytes, htmlBytes: widget.htmlBytes, kind: "a2ui" }));
  let updatable = true;
  try {
    await dependencies.repository.save({
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
      caption: input.caption,
      dataModel: surface.dataModel,
      surface: { actions: widget.actions, baked: widget.baked, bindings: widget.bindings, frozen: widget.frozen, sendDataModel: surface.sendDataModel, slots: widget.slots },
      surfaceId: surface.surfaceId,
      telegramChatId: delivery.chatId,
      telegramMessageId,
    });
  } catch (error) {
    // Telegram already shows the widget; sending it again would duplicate it. It just cannot be pressed or updated.
    updatable = false;
    console.error(JSON.stringify({ code: "AGENT_WIDGET_RECORD_FAILED", error: error instanceof Error ? error.message : String(error), telegramMessageId }));
  }
  const projectionCompleted = await dependencies.recordTimeline(ctx, delivery.timelineTarget, {
    contentText: `[виджет ${surface.surfaceId}] ${input.caption}`,
    failureCode: "AGENT_WIDGET_PROJECTION_FAILED",
    telegramMessageId,
  });
  const actions = [...new Set(widget.actions.map((action) => action.name))];
  return {
    actions: updatable ? actions : [],
    delivered: true,
    nextStep: updatable ? nextStep(actions, surface.surfaceId) : nextStep([], null),
    projectionCompleted,
    retryable: false,
    sideEffectStatus: "completed",
    surfaceId: surface.surfaceId,
    telegramMessageId,
    updatable,
  };
}

async function sendHtml(dependencies: SendWidgetDependencies, input: SendWidgetInput, ctx: ToolContext, delivery: Delivery) {
  // The model's code is checked as written; what is sent and checked by Telegram carries the link guard first.
  const quick = preflightHtmlWidget(input.html!);
  const html = withTelegramLinkGuard(input.html!);
  const sent = preflightHtmlWidget(html);
  const sizeFindings = sent.findings.filter((finding) => finding.code === "compressed_too_large" || finding.code === "html_too_large");
  if (quick.findings.length === 0 && sizeFindings.length > 0) quick.findings.push(...sizeFindings);
  if (quick.findings.length > 0) {
    console.info(JSON.stringify({ code: "AGENT_WIDGET_HTML_REFUSED", findings: quick.findings.map((finding) => finding.code), stage: "preflight" }));
    throw htmlRefused(quick.findings);
  }
  const verdict = await dependencies.check(html);
  if (verdict.refusals.length > 0) {
    console.info(JSON.stringify({ code: "AGENT_WIDGET_HTML_REFUSED", findings: verdict.refusals.map((finding) => finding.code), stage: "official" }));
    throw htmlRefused(verdict.refusals);
  }
  const telegramMessageId = await deliver(dependencies, delivery, {
    caption: input.caption,
    html,
    ...(input.height === undefined ? {} : { height: input.height }),
  });
  console.info(JSON.stringify({ code: "AGENT_WIDGET_SENT", compressedBytes: sent.compressedBytes, htmlBytes: sent.htmlBytes, kind: "html", warnings: verdict.warnings.length }));
  const projectionCompleted = await dependencies.recordTimeline(ctx, delivery.timelineTarget, {
    contentText: `[виджет] ${input.caption}`,
    failureCode: "AGENT_WIDGET_PROJECTION_FAILED",
    telegramMessageId,
  });
  return {
    delivered: true,
    nextStep: nextStep([], null),
    projectionCompleted,
    retryable: false,
    sideEffectStatus: "completed",
    telegramMessageId,
    updatable: false,
    ...(verdict.warnings.length === 0 ? {} : { warnings: verdict.warnings.slice(0, 10) }),
  };
}

export async function sendWidget(dependencies: SendWidgetDependencies, input: SendWidgetInput, ctx: ToolContext, delivery: Delivery): Promise<Record<string, unknown>> {
  return input.surface !== undefined
    ? await sendSurface(dependencies, input, ctx, delivery)
    : await sendHtml(dependencies, input, ctx, delivery);
}
