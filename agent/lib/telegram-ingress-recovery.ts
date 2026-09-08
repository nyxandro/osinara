/** Recovery observes the same durable execution; it never resubmits the inbound update. */
import { runTelegramProcessing, TelegramProcessingTimeout, type DeadlineSession } from "./telegram-processing-deadline.js";
import { waitForSessionBoundary } from "./telegram-session-boundary.js";
import type { TelegramIngressDispatchBinding } from "./telegram-ingress-contract.js";

export async function recoverTelegramIngress(input: {
  dispatch: TelegramIngressDispatchBinding | null;
  attach(sessionId: string): DeadlineSession;
  timeoutMs: number;
  cancellationMs: number;
  signal?: AbortSignal;
  cancel?: boolean;
}): Promise<{ sessionId: string; nextEventIndex: number }> {
  const binding = input.dispatch;
  if (!binding) throw new TelegramProcessingTimeout(undefined, true,
    new Error("AGENT_TELEGRAM_DISPATCH_BINDING_MISSING: The interrupted dispatch has no verified Eve binding"));

  let interrupted = false;
  const completion = await runTelegramProcessing({
    dispatchId: binding.id,
    initialTurnId: binding.turnId,
    signal: input.signal,
    timeoutMilliseconds: input.timeoutMs,
    cancellationMilliseconds: input.cancellationMs,
    readCursor: async () => binding.cursor,
    execute: async (control) => {
      const session = input.attach(binding.sessionId);
      if (session.id !== binding.sessionId) throw new TelegramProcessingTimeout(binding.sessionId, true);
      control.observeSession(session);
      if (input.cancel) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([session.cancel({ turnId: binding.turnId }), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("AGENT_TELEGRAM_RECOVERY_CANCEL_TIMEOUT")), input.cancellationMs);
          })]);
        } finally { clearTimeout(timer); }
      }
      const nextEventIndex = await waitForSessionBoundary(session, binding.cursor, input.timeoutMs, {
        idle: true,
        accepts: control.acceptsEvent,
        async event(event) {
          if (["turn.cancelled", "turn.failed", "session.failed"].includes(event.type)) interrupted = true;
        },
      });
      control.signal.throwIfAborted();
      return { sessionId: session.id, nextEventIndex };
    },
  });
  if (interrupted) throw new TelegramProcessingTimeout(binding.sessionId, false,
    new Error("AGENT_TELEGRAM_RECOVERED_INTERRUPTION: The original execution stopped without successful completion"), false);
  return completion;
}
