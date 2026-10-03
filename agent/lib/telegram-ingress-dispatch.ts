/**
 * What the verified ingress adds to the runtime's Telegram dispatch of one update.
 *
 * Exports:
 * - `telegramIngressControl`: the update's identity and admission deadline in the turn's auth, the
 *   checkpointed preparation, and the update's record of its turn in the same transaction.
 * - `requireTelegramAdmissionDeadline`, `TelegramProcessingTimeout`: a turn that did not start within
 *   the admission window never starts.
 *
 * Replaces `telegram-ingress-dispatch-control.ts`, `telegram-ingress-binding.ts` and the deadline
 * part of `telegram-processing-deadline.ts`: the turn is created in one transaction with the
 * update's binding, so a restart finds either both or neither.
 */
import type { SessionAuth } from "../runtime/context.js";
import type { TelegramDispatchControl, TelegramDispatchTarget } from "../runtime/telegram/telegram-dispatch.js";
import type { JournalClient } from "../runtime/turn/journal-repository.js";

import { AppError } from "./app-error.js";
import { prepareTelegramIngress, type TelegramPreparationContext } from "./telegram-ingress-preparation.js";

export class TelegramProcessingTimeout extends AppError {
  constructor() {
    super("AGENT_TELEGRAM_PROCESSING_TIMEOUT",
      "Запрос превысил время обработки и остановлен. Если он менял данные, проверьте результат перед повтором");
  }
}

/** Checked when a turn starts: queued past its window, the request is answered with a timeout. */
export function requireTelegramAdmissionDeadline(auth: SessionAuth, now = Date.now()): void {
  const value = auth.current?.attributes.osinaraTelegramDeadlineAt;
  // Background turns and continuations of persisted turns have no ingress admission deadline.
  if (value === undefined) return;
  const expires = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(expires)) throw new AppError("AGENT_TELEGRAM_DEADLINE_INVALID", "Не удалось проверить срок обработки сообщения");
  if (now >= expires) throw new TelegramProcessingTimeout();
}

async function bindIngressTurn(
  client: JournalClient,
  ingress: { readonly dispatchId: string; readonly leaseToken: string; readonly updateId: string },
  target: TelegramDispatchTarget,
): Promise<void> {
  // The start index belonged to Eve's event stream; it stays filled only for the table's constraint.
  // The lease token: a worker whose lease expired and went to another worker binds nothing, even
  // though an interrupted dispatch keeps its attempt id for the next worker.
  const result = await client.query(
    `UPDATE telegram_ingress_updates SET dispatch_session_id = $3, dispatch_turn_id = $4, dispatch_start_index = 0, updated_at = now()
      WHERE update_id = $1 AND dispatch_id = $2 AND lease_token = $5::uuid AND status = 'processing' AND lease_expires_at > now()
        AND dispatch_started_at IS NOT NULL AND dispatch_session_id IS NULL`,
    [ingress.updateId, ingress.dispatchId, target.sessionId, target.turnId, ingress.leaseToken],
  );
  if (result.rowCount !== 1) {
    throw new AppError("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED",
      "Обработка сообщения уже закрыта или принадлежит другому запросу. Выполнение остановлено");
  }
}

export function telegramIngressControl(input: {
  readonly deadlineAt: string;
  readonly dispatchId: string;
  /** The queue lease this worker holds the update under. */
  readonly leaseToken: string;
  /** A replay of an interrupted dispatch: a rejected button is not announced a second time. */
  readonly replaying: boolean;
  readonly signal: AbortSignal;
  readonly updateId: string;
}): TelegramDispatchControl {
  const ingress = { dispatchId: input.dispatchId, updateId: input.updateId };
  const binding = { ...ingress, leaseToken: input.leaseToken };
  return {
    attributes: {
      osinaraTelegramDeadlineAt: input.deadlineAt,
      osinaraTelegramIngressId: input.dispatchId,
      osinaraTelegramUpdateId: input.updateId,
    },
    bind: (client, target) => bindIngressTurn(client, binding, target),
    prepareCallback: (context, query, token, prepare) => {
      const verified: TelegramPreparationContext = { ...context, ingressRecovery: { ...ingress, ...(input.replaying ? { replaying: true } : {}) } };
      return prepare(verified, query, token);
    },
    prepareMessage: (context, message, prepare) =>
      prepareTelegramIngress({ ...ingress, context, message, prepare: async (ctx, msg) => await prepare(ctx, msg) }),
    signal: input.signal,
  };
}
