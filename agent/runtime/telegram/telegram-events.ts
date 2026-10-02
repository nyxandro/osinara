/**
 * The runtime's turn events, delivered to the application's Telegram handlers.
 *
 * Export:
 * - `telegramTurnObserver`: a `TurnObserver` for turns of the Telegram channel. Each handler gets
 *   the conversation's Telegram handle and state, and the turn in Eve's handler shape; what a
 *   handler changes in the state is saved right after it.
 *
 * Derived from eve 0.40.0 `public/channels/telegram/telegramChannel.ts` (`rebuildTelegramContext`)
 * and `defaults.ts` (`actions.requested` shows "typing") (Apache-2.0, see NOTICE-eve). Eve's other
 * default handlers are not used: the application replaces every one of them.
 */
import type { TurnObserver, TurnOutcome } from "../turn/run-turn.js";
import type { TurnRecord } from "../turn/turn-types.js";
import type { JournalDatabase } from "../turn/journal-repository.js";
import { AppError } from "../../lib/app-error.js";
import { loadChannelState, saveChannelState } from "../session/continuations.js";
import type { TelegramChannelState, TelegramEventContext, TelegramTurnContext, TelegramTurnEvents } from "./channel-types.js";
import { buildTelegramHandle, type TelegramTransport } from "./handle.js";

type ObserverDatabase = JournalDatabase & Parameters<typeof loadChannelState>[0];

function turnContext(turn: TurnRecord): TelegramTurnContext {
  return { session: { auth: turn.auth, id: turn.sessionId, turn: { id: turn.id, sequence: turn.sequence } } };
}

export function telegramTurnObserver(input: {
  readonly database: ObserverDatabase;
  readonly events: TelegramTurnEvents;
  readonly transport: TelegramTransport;
}): TurnObserver {
  const { database, events } = input;

  async function withChannel(turn: TurnRecord, handle: (channel: TelegramEventContext, ctx: TelegramTurnContext) => Promise<void>): Promise<void> {
    const state = await loadChannelState<TelegramChannelState>(database, turn.sessionId);
    if (state === null) {
      throw new AppError("AGENT_TELEGRAM_CHANNEL_STATE_MISSING", "Не удалось восстановить состояние разговора Telegram", {
        details: { sessionId: turn.sessionId },
      });
    }
    const before = JSON.stringify(state);
    const channel: TelegramEventContext = {
      ...(turn.channel.continuationToken === undefined ? {} : { continuation: { token: turn.channel.continuationToken } }),
      state,
      telegram: buildTelegramHandle({ state, transport: input.transport }),
    };
    await handle(channel, turnContext(turn));
    if (JSON.stringify(state) !== before) await saveChannelState(database, turn.sessionId, state);
  }

  async function finished(turn: TurnRecord, outcome: TurnOutcome): Promise<void> {
    if (outcome.status === "completed" || outcome.status === "waiting_input") {
      await withChannel(turn, (channel, ctx) => events["turn.completed"]({ status: outcome.status }, channel, ctx));
      return;
    }
    if (outcome.status === "failed") {
      await withChannel(turn, (channel, ctx) => events["turn.failed"]({ code: outcome.code, message: outcome.message }, channel, ctx));
      return;
    }
    await withChannel(turn, (channel, ctx) => events["turn.cancelled"]({}, channel, ctx));
  }

  return {
    async turnStarted(turn) {
      await withChannel(turn, (channel, ctx) => events["turn.started"]({}, channel, ctx));
    },
    async stepText(event) {
      const data = { finishReason: event.finishReason, message: event.message, stepIndex: event.stepIndex };
      await withChannel(event.turn, (channel, ctx) => events["message.completed"](data, channel, ctx));
    },
    async toolsStarted(event) {
      const handler = events["actions.requested"];
      await withChannel(event.turn, (channel, ctx) => handler === undefined
        ? channel.telegram.startTyping()
        : handler({ stepIndex: event.stepIndex }, channel, ctx));
    },
    async inputRequested(event) {
      await withChannel(event.turn, (channel, ctx) => events["input.requested"]({ requests: event.requests }, channel, ctx));
    },
    async turnFinished(event) {
      await finished(event.turn, event.outcome);
    },
  };
}
