/**
 * The runtime's Telegram path for integration tests of the application's ingress: the real channel
 * dispatch, the turn dispatcher and the journal over the test database, with a scripted model, a
 * Bot API double and turn-event handlers that only record what they were given.
 *
 * Export:
 * - `runtimeTelegram`: `dispatch` and `runTurn` as the production ingress receives them.
 *
 * Test-only: imported by `*.integration.test.ts` files, never by application code.
 */
import { vi } from "vitest";

import type { TelegramTurnEvents } from "../runtime/telegram/channel-types.js";
import { createTelegramChannel } from "../runtime/telegram/telegram-channel.js";
import type { TelegramChannelHooks } from "../runtime/telegram/telegram-dispatch.js";
import { createTurnDispatcher } from "../runtime/dispatch.js";
import type { ToolDefinition } from "../runtime/tool.js";
import { routeTurnObservers } from "../runtime/turn/observer-routing.js";
import { HELD_RUNNER_LOCK, scriptedModel, testAgent, testRuntime, type ScriptStep } from "../runtime/turn/turn.integration-fixtures.js";
import { database } from "./database.js";

export function runtimeTelegram(input: {
  readonly onHitlCallbackQuery?: TelegramChannelHooks["onHitlCallbackQuery"];
  readonly onMessage: TelegramChannelHooks["onMessage"];
  readonly steps: readonly ScriptStep[];
  readonly tools?: Readonly<Record<string, ToolDefinition<any, any>>>;
}) {
  const events: Array<{ readonly data: unknown; readonly kind: string; readonly turnId: string }> = [];
  const record = (kind: string) => async (data: unknown, _channel: unknown, ctx: { session: { turn: { id: string } } }) => {
    events.push({ data, kind, turnId: ctx.session.turn.id });
  };
  const handlers: TelegramTurnEvents = {
    "input.requested": record("input.requested"),
    "message.completed": record("message.completed"),
    "turn.cancelled": record("turn.cancelled"),
    "turn.completed": record("turn.completed"),
    "turn.failed": record("turn.failed"),
    "turn.started": record("turn.started"),
  };
  const fetch = vi.fn(async () => Response.json({ ok: true, result: true }));
  const channel = createTelegramChannel({
    api: { fetch: fetch as never },
    botToken: "test-token",
    botUsername: "osinara_bot",
    database: database(),
    events: handlers,
    onHitlCallbackQuery: input.onHitlCallbackQuery ?? (async () => null),
    onMessage: input.onMessage,
  });
  const model = scriptedModel(...input.steps);
  const dispatcher = createTurnDispatcher({
    admit: async (work) => await work(),
    runnerLock: HELD_RUNNER_LOCK,
    runtime: testRuntime({
      agent: testAgent(input.tools ?? {}),
      callModel: model.callModel,
      observer: routeTurnObservers({ telegram: channel.observer }),
    }),
    waitMilliseconds: 50,
  });
  return {
    dispatch: channel.dispatch,
    dispatcher,
    events,
    fetch,
    model,
    runTurn: dispatcher.run,
  };
}
