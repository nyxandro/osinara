/**
 * The tool that changes the shown values of an A2UI widget the agent sent to this chat earlier.
 *
 * Exports:
 * - `createUpdateWidgetTool`: dependency-injected update of one widget.
 * - Default `update_widget`: the production tool over Telegram's `editMessageWidgetData` (Bot API 10.4 beta).
 *
 * Key constructs:
 * - The input is the protocol's own `updateDataModel` messages; their `surfaceId` names the widget, and
 *   only a widget sent to this same chat can be found.
 * - The data changes under the widget's row lock and only after Telegram took the new shared state, so
 *   the stored data and what people see move together; a refused edit leaves both as they were.
 * - Telegram changes the widget silently: no new message, no notification.
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { applyWidgetUpdates } from "../widgets/a2ui/update.js";
import { widgetRepository } from "../widgets/widget-repository.js";
import { type WidgetTelegram, widgetTelegram } from "../widgets/widget-telegram.js";
import { requireTelegramDeliveryTarget } from "../workspaces/workspace-context.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface UpdateWidgetDependencies {
  readonly repository: Pick<typeof widgetRepository, "findBySurface" | "updateData">;
  readonly telegram: Pick<WidgetTelegram, "editPublicData">;
}

const inputSchema = z.object({
  updates: z.array(z.record(z.string(), z.unknown())).min(1).max(10)
    .describe("1-10 A2UI 1.0 messages { version: \"1.0\", updateDataModel: { surfaceId, path, value } } for one widget; value null deletes"),
}).strict();

function failure(input: { code: string; correction: string; reason: string; category: "input" | "dependency" }): ModelFacingError {
  return new ModelFacingError({
    category: input.category,
    code: input.code,
    correction: input.correction,
    reason: input.reason,
    retryable: input.category === "input",
    sideEffectStatus: "not_started",
  });
}

const NEW_WIDGET = "Не вызывай update_widget для него снова: пришли новый виджет через send_widget или ответь обычным текстом.";

export function createUpdateWidgetTool(dependencies: UpdateWidgetDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Change the values an A2UI widget you sent to this chat shows: a count, a status, a progress bar.",
      "Use the surfaceId of that widget. The layout never changes after sending; for another layout send a new widget.",
      "After the result follow nextStep; on an error follow correction.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      const parsed = inputSchema.safeParse(rawInput);
      const first = parsed.success ? parsed.data.updates[0]?.updateDataModel : undefined;
      const surfaceId = first !== null && typeof first === "object" && typeof (first as { surfaceId?: unknown }).surfaceId === "string"
        ? (first as { surfaceId: string }).surfaceId
        : null;
      if (!parsed.success || surfaceId === null) {
        throw failure({
          category: "input",
          code: "AGENT_WIDGET_UPDATE_INVALID",
          correction: "Передай updates — 1-10 сообщений A2UI { \"version\": \"1.0\", \"updateDataModel\": { \"surfaceId\": …, \"path\": \"/…\", \"value\": … } } для одного виджета, и повтори вызов один раз.",
          reason: "Параметры обновления виджета не прошли проверку.",
        });
      }
      const target = requireTelegramDeliveryTarget(ctx);
      const widget = await dependencies.repository.findBySurface(target.chatId, surfaceId);
      if (widget === null) {
        throw failure({
          category: "input",
          code: "AGENT_WIDGET_NOT_FOUND",
          correction: `В этом чате нет виджета с surfaceId «${surfaceId}». Возьми surfaceId из результата send_widget или из строки [виджет …] в истории; если виджета нет, пришли новый.`,
          reason: "Виджет для обновления не найден.",
        });
      }
      try {
        const updated = await dependencies.repository.updateData(widget.id, async (locked) => {
          const result = applyWidgetUpdates(locked, parsed.data.updates);
          if (!result.ok) {
            throw failure(result.code === "AGENT_WIDGET_UPDATE_INVALID"
              ? { category: "input", code: result.code, correction: `${result.reason}. Исправь и повтори вызов один раз.`, reason: "Обновление виджета не прошло проверку." }
              : { category: "dependency", code: result.code, correction: `${result.reason}. ${NEW_WIDGET}`, reason: "Этот виджет нельзя обновить так." });
          }
          // The same data again changes nothing: no call to Telegram, no new revision.
          const unchanged = JSON.stringify(result.dataModel) === JSON.stringify(locked.dataModel);
          const publish = result.publicData !== null && !unchanged;
          if (publish) {
            await dependencies.telegram.editPublicData({ chatId: locked.telegramChatId, messageId: locked.telegramMessageId, publicData: result.publicData! });
          }
          return { bumpRevision: publish, dataModel: result.dataModel, result: { ...result, visibleChanges: unchanged ? 0 : result.visibleChanges } };
        });
        if (updated === null) throw new Error("AGENT_WIDGET_UPDATE_LOST: the widget disappeared while it was updated");
        console.info(JSON.stringify({ code: "AGENT_WIDGET_UPDATED", revision: updated.widget.revision, visibleChanges: updated.result.visibleChanges }));
        return {
          nextStep: "Виджет уже показывает новые значения у всех в чате, без уведомления. Не пересказывай его; если нужны слова, напиши только их.",
          revision: updated.widget.revision,
          updated: true,
          visibleChanges: updated.result.visibleChanges,
        };
      } catch (error) {
        if (error instanceof ModelFacingError) throw error;
        console.error(JSON.stringify({ code: "AGENT_WIDGET_UPDATE_FAILED", error: error instanceof Error ? error.message : String(error), ...(isAppError(error) && error.details !== undefined ? { details: error.details } : {}) }));
        throw failure({
          category: "dependency",
          code: "AGENT_WIDGET_UPDATE_FAILED",
          correction: `Telegram не принял обновление; виджет показывает прежние значения. ${NEW_WIDGET}`,
          reason: "Не удалось обновить виджет.",
        });
      }
    },
  }) as AnyToolDefinition;
}

export default createUpdateWidgetTool({ repository: widgetRepository, telegram: widgetTelegram });
