/**
 * The Telegram channel of the runtime: webhook routes, dispatch of updates, and turn events.
 *
 * Exports:
 * - `createTelegramChannel`: binds the application's hooks and handlers to the database and the
 *   Bot API; `dispatch` turns one verified update into a turn, `observer` delivers that turn's
 *   events to the application's handlers.
 * - `telegramWebhookRoutes`: the public webhook and the internal drain route. Both verify the
 *   webhook secret; the webhook hands a parsed update to the application's ingress, which stores it
 *   before Telegram is acknowledged.
 *
 * Derived from eve 0.40.0 `public/channels/telegram/telegramChannel.ts` (`telegramChannel`,
 * `verifyInbound`) with Osinara's ingress patches (`onVerifiedUpdate`, `onDrain`, `drainRoute`)
 * (Apache-2.0, see NOTICE-eve).
 */
import type { JsonObject } from "../json.js";
import { parseJsonObject } from "../json.js";
import type { RouteContext, RuntimeRoute } from "../server.js";
import type { TurnObserver } from "../turn/run-turn.js";
import type { JournalDatabase } from "../turn/journal-repository.js";
import type { TelegramApiOptions } from "./api.js";
import type { TelegramTurnEvents } from "./channel-types.js";
import type { TelegramTransport } from "./handle.js";
import { parseTelegramUpdate, type TelegramUpdate } from "./inbound.js";
import {
  dispatchTelegramCallback, dispatchTelegramMessage, type TelegramChannelHooks, type TelegramDispatchControl,
  type TelegramDispatchResult,
} from "./telegram-dispatch.js";
import { telegramTurnObserver } from "./telegram-events.js";
import { verifyTelegramRequest } from "./verify.js";

export interface TelegramChannel {
  dispatch(update: TelegramUpdate, control?: TelegramDispatchControl): Promise<TelegramDispatchResult>;
  readonly observer: TurnObserver;
  readonly transport: TelegramTransport;
}

export function createTelegramChannel(input: {
  readonly api?: Omit<TelegramApiOptions, "credentials">;
  readonly botToken: string;
  readonly botUsername: string;
  readonly database: Parameters<typeof telegramTurnObserver>[0]["database"] & JournalDatabase;
  readonly events: TelegramTurnEvents;
  readonly onHitlCallbackQuery: TelegramChannelHooks["onHitlCallbackQuery"];
  readonly onMessage: TelegramChannelHooks["onMessage"];
}): TelegramChannel {
  const transport: TelegramTransport = {
    ...(input.api === undefined ? {} : { api: input.api }),
    botUsername: input.botUsername,
    credentials: { botToken: input.botToken },
  };
  const hooks: TelegramChannelHooks = {
    botUsername: input.botUsername,
    onHitlCallbackQuery: input.onHitlCallbackQuery,
    onMessage: input.onMessage,
    transport,
  };
  return {
    async dispatch(update, control) {
      return update.kind === "message"
        ? await dispatchTelegramMessage(input.database, hooks, update.message, control)
        : await dispatchTelegramCallback(input.database, hooks, update.callbackQuery, control);
    },
    observer: telegramTurnObserver({ database: input.database, events: input.events, transport }),
    transport,
  };
}

async function verifiedBody(request: Request, webhookSecretToken: string): Promise<string | null> {
  try {
    return await verifyTelegramRequest(request, { secretToken: webhookSecretToken });
  } catch (error) {
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_REJECTED", error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

export function telegramWebhookRoutes(input: {
  readonly drainRoute: string;
  readonly onDrain: (context: RouteContext) => Promise<Response>;
  readonly onVerifiedUpdate: (context: RouteContext & { readonly raw: JsonObject; readonly update: TelegramUpdate }) => Promise<Response>;
  readonly route: string;
  readonly webhookSecretToken: string;
}): RuntimeRoute[] {
  return [
    {
      method: "POST",
      path: input.route,
      async handle(request, context) {
        const body = await verifiedBody(request, input.webhookSecretToken);
        if (body === null) return new Response("unauthorized", { status: 401 });
        let raw: JsonObject;
        try {
          raw = parseJsonObject(JSON.parse(body) as unknown);
        } catch (error) {
          // Telegram would redeliver a rejected update forever; a malformed one is acknowledged.
          console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_BODY_INVALID", error: error instanceof Error ? error.message : String(error) }));
          return new Response("ok");
        }
        const update = parseTelegramUpdate(raw);
        if (update === null) return new Response("ok");
        return await input.onVerifiedUpdate({ ...context, raw, update });
      },
    },
    {
      method: "POST",
      path: input.drainRoute,
      async handle(request, context) {
        if (await verifiedBody(request, input.webhookSecretToken) === null) return new Response("unauthorized", { status: 401 });
        return await input.onDrain(context);
      },
    },
  ];
}
