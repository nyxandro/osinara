/**
 * PostgreSQL state of A2UI widgets sent by the agent and of the presses in them.
 *
 * Exports:
 * - `StoredWidget`, `StoredWidgetSurface`: one widget as the press and update paths read it.
 * - `WidgetQueryClaim`: the decision on one press.
 * - `widgetRepository`: saving a sent widget, finding it by its message or its surfaceId, updating its
 *   data under a row lock, and claiming a press.
 *
 * Key constructs:
 * - A press is decided in one transaction under the widget's row lock and known by Telegram's query id:
 *   a press Telegram delivers again finds its own decision and its message, built once, so the chat
 *   queue receives byte for byte the same message. A second press of the same person while their first
 *   is not processed yet is refused (owner's decision F8, #468). "Not processed" is the first press's
 *   message still pending or processing in the chat queue — or not queued yet for up to two minutes
 *   after the claim; after that a press that never reached the queue no longer blocks the person.
 * - The widget's data model changes only together with its revision, so the shared state the widget
 *   receives never goes back to an older picture.
 */
import { database } from "../database.js";
import type { JsonObject } from "./a2ui/a2ui-types.js";
import type { ChoiceSlot, FrozenRead, WidgetAction, WidgetBinding } from "./a2ui/render.js";

export interface StoredWidgetSurface {
  readonly actions: readonly WidgetAction[];
  readonly baked: Readonly<Record<string, string | number>>;
  readonly bindings: readonly WidgetBinding[];
  readonly frozen: readonly FrozenRead[];
  readonly sendDataModel: boolean;
  readonly slots: readonly ChoiceSlot[];
}

export interface StoredWidget {
  readonly agentSessionId: string;
  readonly caption: string;
  readonly dataModel: JsonObject;
  readonly id: string;
  readonly revision: number;
  readonly surface: StoredWidgetSurface;
  readonly surfaceId: string;
  readonly telegramChatId: string;
  readonly telegramMessageId: string;
}

export type WidgetQueryClaim =
  | {
    readonly ingressUpdateId: string;
    /** The press's message as first built; null until it is stored. */
    readonly payload: JsonObject | null;
    readonly status: "accepted" | "replayed";
    readonly widget: StoredWidget;
  }
  | { readonly status: "refused_busy" | "refused_closed" | "refused_invalid" };

interface WidgetRow {
  agent_session_id: string;
  caption: string;
  data_model: JsonObject;
  id: string;
  revision: number;
  surface: StoredWidgetSurface;
  surface_id: string;
  telegram_chat_id: string;
  telegram_message_id: string;
}

/** How long a claimed press may wait for its message to reach the queue before it stops counting as busy. */
const UNQUEUED_PRESS_BUSY_SECONDS = 120;

const COLUMNS = "id, telegram_chat_id, telegram_message_id::text, surface_id, agent_session_id, caption, surface, data_model, revision";

function toWidget(row: WidgetRow): StoredWidget {
  return {
    agentSessionId: row.agent_session_id,
    caption: row.caption,
    dataModel: row.data_model,
    id: row.id,
    revision: row.revision,
    surface: row.surface,
    surfaceId: row.surface_id,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
  };
}

export const widgetRepository = {
  async surfaceIdTaken(telegramChatId: string, surfaceId: string): Promise<boolean> {
    const found = await database().query(
      "SELECT 1 FROM telegram_widgets WHERE telegram_chat_id = $1 AND surface_id = $2",
      [telegramChatId, surfaceId],
    );
    return (found.rowCount ?? 0) > 0;
  },

  async save(input: {
    readonly agentSessionId: string;
    readonly agentTurnId: string;
    readonly caption: string;
    readonly dataModel: JsonObject;
    readonly surface: StoredWidgetSurface;
    readonly surfaceId: string;
    readonly telegramChatId: string;
    readonly telegramMessageId: string;
  }): Promise<StoredWidget> {
    const saved = await database().query<WidgetRow>(
      `INSERT INTO telegram_widgets
         (telegram_chat_id, telegram_message_id, surface_id, agent_session_id, agent_turn_id, caption, surface, data_model)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING ${COLUMNS}`,
      [
        input.telegramChatId, input.telegramMessageId, input.surfaceId, input.agentSessionId, input.agentTurnId,
        input.caption, JSON.stringify(input.surface), JSON.stringify(input.dataModel),
      ],
    );
    return toWidget(saved.rows[0]!);
  },

  async findByMessage(telegramChatId: string, telegramMessageId: string): Promise<StoredWidget | null> {
    const found = await database().query<WidgetRow>(
      `SELECT ${COLUMNS} FROM telegram_widgets WHERE telegram_chat_id = $1 AND telegram_message_id = $2::bigint`,
      [telegramChatId, telegramMessageId],
    );
    return found.rows[0] === undefined ? null : toWidget(found.rows[0]);
  },

  async findBySurface(telegramChatId: string, surfaceId: string): Promise<StoredWidget | null> {
    const found = await database().query<WidgetRow>(
      `SELECT ${COLUMNS} FROM telegram_widgets WHERE telegram_chat_id = $1 AND surface_id = $2`,
      [telegramChatId, surfaceId],
    );
    return found.rows[0] === undefined ? null : toWidget(found.rows[0]);
  },

  /**
   * Applies `change` to the current data under the row lock and stores its result, with the next
   * revision when the shown state changed. `change` decides from the locked row; it returns null to
   * leave the widget as it is.
   */
  async updateData<T>(
    widgetId: string,
    change: (widget: StoredWidget) => Promise<{ readonly bumpRevision: boolean; readonly dataModel: JsonObject; readonly result: T } | null>,
  ): Promise<{ readonly result: T; readonly widget: StoredWidget } | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<WidgetRow>(`SELECT ${COLUMNS} FROM telegram_widgets WHERE id = $1 FOR UPDATE`, [widgetId]);
      const row = found.rows[0];
      if (row === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const changed = await change(toWidget(row));
      if (changed === null) {
        await client.query("ROLLBACK");
        return null;
      }
      const updated = await client.query<WidgetRow>(
        `UPDATE telegram_widgets SET data_model = $2::jsonb, revision = revision + CASE WHEN $3 THEN 1 ELSE 0 END, updated_at = now()
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [widgetId, JSON.stringify(changed.dataModel), changed.bumpRevision],
      );
      await client.query("COMMIT");
      return { result: changed.result, widget: toWidget(updated.rows[0]!) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimQuery(input: {
    readonly actionIndex: number | null;
    readonly betaUpdateId: string;
    readonly ingressUpdateId: string;
    readonly revision: number | null;
    readonly telegramChatId: string;
    readonly telegramMessageId: string;
    readonly telegramUserId: string;
    readonly widgetQueryId: string;
  }): Promise<WidgetQueryClaim> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<WidgetRow>(
        `SELECT ${COLUMNS} FROM telegram_widgets WHERE telegram_chat_id = $1 AND telegram_message_id = $2::bigint FOR UPDATE`,
        [input.telegramChatId, input.telegramMessageId],
      );
      const row = found.rows[0];
      const earlier = await client.query<{ status: string; ingress_update_id: string | null; message_payload: JsonObject | null }>(
        "SELECT status, ingress_update_id::text, message_payload FROM telegram_widget_queries WHERE widget_query_id = $1",
        [input.widgetQueryId],
      );
      const previous = earlier.rows[0];
      if (previous !== undefined) {
        await client.query("COMMIT");
        return previous.status === "accepted" && row !== undefined && previous.ingress_update_id !== null
          ? { ingressUpdateId: previous.ingress_update_id, payload: previous.message_payload, status: "replayed", widget: toWidget(row) }
          : { status: previous.status as "refused_busy" | "refused_closed" | "refused_invalid" };
      }
      const record = async (status: string, accepted: boolean) => {
        await client.query(
          `INSERT INTO telegram_widget_queries
             (beta_update_id, widget_id, widget_query_id, telegram_user_id, action_index, revision, status, ingress_update_id)
           VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8::bigint)`,
          [
            input.betaUpdateId, row?.id ?? null, input.widgetQueryId, input.telegramUserId,
            input.actionIndex, input.revision, status, accepted ? input.ingressUpdateId : null,
          ],
        );
      };
      if (row === undefined) {
        await record("refused_closed", false);
        await client.query("COMMIT");
        return { status: "refused_closed" };
      }
      if (input.actionIndex === null || input.revision === null || input.actionIndex >= row.surface.actions.length) {
        await record("refused_invalid", false);
        await client.query("COMMIT");
        return { status: "refused_invalid" };
      }
      const busy = await client.query(
        `SELECT 1 FROM telegram_widget_queries query
           LEFT JOIN telegram_ingress_updates item ON item.update_id = query.ingress_update_id
          WHERE query.widget_id = $1 AND query.telegram_user_id = $2 AND query.status = 'accepted'
            AND (item.status IN ('pending', 'processing')
              OR (item.update_id IS NULL AND query.created_at > now() - ($3 * interval '1 second')))
          LIMIT 1`,
        [row.id, input.telegramUserId, UNQUEUED_PRESS_BUSY_SECONDS],
      );
      if ((busy.rowCount ?? 0) > 0) {
        await record("refused_busy", false);
        await client.query("COMMIT");
        return { status: "refused_busy" };
      }
      await record("accepted", true);
      await client.query("COMMIT");
      return { ingressUpdateId: input.ingressUpdateId, payload: null, status: "accepted", widget: toWidget(row) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** Stores the press's message once; a later build of the same press gets the first one back. */
  async storePressPayload(widgetQueryId: string, payload: JsonObject): Promise<JsonObject> {
    const stored = await database().query<{ message_payload: JsonObject }>(
      `UPDATE telegram_widget_queries SET message_payload = coalesce(message_payload, $2::jsonb)
        WHERE widget_query_id = $1 AND status = 'accepted' RETURNING message_payload`,
      [widgetQueryId, JSON.stringify(payload)],
    );
    const row = stored.rows[0];
    if (row === undefined) throw new Error("AGENT_WIDGET_QUERY_MISSING: the accepted press to store a message for is gone");
    return row.message_payload;
  },
};
