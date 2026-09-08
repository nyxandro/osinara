/** Bound admission only; native model timers own execution. Confirm cancellation on observer loss. */
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { SessionAuth } from "eve/context";
import { AppError } from "./app-error.js";
import { waitForSessionBoundary, type BoundaryEvent, type EveSessionResult } from "./telegram-session-boundary.js";

export interface DeadlineSession extends EveSessionResult {
  cancel(options: { turnId: string }): Promise<{ status: "accepted"; sessionId: string } | { status: "no_active_turn" }>;
}
interface ProcessingControl {
  updateId?: string;
  signal: AbortSignal;
  deadlineAt: string;
  dispatchId: string;
  onDispatch(target: { resolveSession(): Promise<DeadlineSession | undefined> }): void;
  observeSession(session: DeadlineSession): void;
  acceptsEvent(event: BoundaryEvent): boolean;
}

export class TelegramProcessingTimeout extends AppError {
  constructor(readonly eveSessionId: string | undefined, unconfirmed = false, cause?: unknown, timedOut = true) {
    super(unconfirmed ? "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" : timedOut ? "AGENT_TELEGRAM_PROCESSING_TIMEOUT" : "AGENT_TELEGRAM_PROCESSING_INTERRUPTED",
      unconfirmed
        ? "Не удалось подтвердить остановку запроса. Новые сообщения этого чата приостановлены. Обратитесь к владельцу агента"
        : timedOut
          ? "Запрос превысил время обработки и остановлен. Если он менял данные, проверьте результат перед повтором"
          : "Обработка запроса прервана и остановлена. Если запрос менял данные, проверьте результат перед повтором");
    if (cause !== undefined) this.cause = cause;
  }
}

export function requireTelegramAdmissionDeadline(auth: SessionAuth, now = Date.now()): void {
  const value = auth.current?.attributes.osinaraTelegramDeadlineAt;
  // Checked only during turn admission, never while an admitted model/tool is still working.
  // Background sessions and persisted pre-upgrade turns have no ingress admission deadline.
  if (value === undefined) return;
  const expires = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(expires)) throw new AppError("AGENT_TELEGRAM_DEADLINE_INVALID", "Не удалось проверить срок обработки сообщения");
  if (now >= expires) throw new TelegramProcessingTimeout(undefined);
}

export async function runTelegramProcessing<T>(input: {
  dispatchId?: string;
  updateId?: string;
  initialTurnId?: string;
  timeoutMilliseconds: number;
  cancellationMilliseconds: number;
  signal?: AbortSignal;
  readCursor(sessionId: string): Promise<number>;
  execute(control: ProcessingControl): Promise<T>;
}): Promise<T> {
  if (![input.timeoutMilliseconds, input.cancellationMilliseconds].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new AppError("AGENT_TELEGRAM_DEADLINE_INVALID", "Не задан допустимый срок обработки сообщения");
  }
  const controller = new AbortController();
  const dispatchId = input.dispatchId ?? randomUUID();
  let observedTurnId: string | undefined = input.initialTurnId;
  const matchesEvent = (event: BoundaryEvent) => event.type === "session.failed" || event.type === "session.completed" ||
    event.data?.osinaraTelegramIngressId === dispatchId;
  const acceptsEvent = (event: BoundaryEvent) => {
    if (!matchesEvent(event)) return false;
    // Eve's approval audit events can precede turn preparation and carry an empty or old turnId.
    // They describe a request decision, not the execution coordinate used for cancellation.
    if (event.type === "approval.candidate" || event.type === "approval.settled") return true;
    const turnId = event.data?.turnId;
    if (turnId !== undefined) {
      if (typeof turnId !== "string" || !turnId) throw new Error("Ingress turn ID is invalid");
      // A question response can resolve the preceding turn before starting the next one.
      // Keep the latest observed coordinate, not the first input.resolved coordinate.
      observedTurnId = turnId;
    }
    return true;
  };
  const expires = Date.now() + input.timeoutMilliseconds;
  let target: { resolveSession(): Promise<DeadlineSession | undefined> } | undefined;
  let session: DeadlineSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TelegramProcessingTimeout(session?.id);
      controller.abort(error);
      reject(error);
    }, input.timeoutMilliseconds);
  });
  let interrupt: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => { controller.abort(input.signal!.reason); reject(input.signal!.reason); };
    if (input.signal?.aborted) interrupt();
    else input.signal?.addEventListener("abort", interrupt, { once: true });
  });
  let sessionMismatch = false;
  function observeSession(value: DeadlineSession) {
    if (session && session.id !== value.id) {
      sessionMismatch = true;
      throw new TelegramProcessingTimeout(session.id, true, new Error("Dispatch session mismatch"));
    }
    session = value;
    clearTimeout(timer);
  }
  const operation = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return input.execute({ signal: controller.signal, deadlineAt: new Date(expires).toISOString(), dispatchId, updateId: input.updateId, acceptsEvent,
    onDispatch(value) { controller.signal.throwIfAborted(); target = value; },
    observeSession,
    });
  });
  // Settling the application operation is required even when Eve has already parked: a slow
  // callback or source.send may still have an outstanding mutation or delivery.
  const settled = operation.then(() => undefined, () => undefined);
  try {
    return await Promise.race([operation, timeout, interrupted]);
  } catch (error) {
    const timedOut = error instanceof TelegramProcessingTimeout || error instanceof AppError && error.code === "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT";
    if (!controller.signal.aborted && !timedOut && !target && !session) throw error;
    clearTimeout(timer);
    controller.abort(error);
    // Before ChannelSource.send/respond, the patched source fence prevents a late preparation
    // from creating a model turn. Once dispatched, only a native session boundary proves settling.
    const cleanup = new AbortController();
    const cleanupExpires = Date.now() + input.cancellationMilliseconds;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupTimeout = new Promise<never>((_resolve, reject) => {
      cleanupTimer = setTimeout(() => {
        cleanup.abort();
        reject(new Error("Eve cancellation did not settle within its cleanup budget"));
      }, input.cancellationMilliseconds);
    });
    const cancel = async () => {
      if (!target && !session) return;
      while (!session) {
        cleanup.signal.throwIfAborted();
        const resolved = await target!.resolveSession();
        cleanup.signal.throwIfAborted();
        if (resolved) observeSession(resolved);
        if (!session) await sleep(Math.min(100, input.cancellationMilliseconds), undefined, { signal: cleanup.signal });
      }
      const exactSession = session;
      const cancelledTurns = new Set<string>();
      const requestCancellation = async () => {
        cleanup.signal.throwIfAborted();
        if (observedTurnId && !cancelledTurns.has(observedTurnId)) {
          cancelledTurns.add(observedTurnId);
          const result = await exactSession.cancel({ turnId: observedTurnId });
          if (result.status === "accepted" && result.sessionId !== exactSession.id) throw new Error("Cancellation session mismatch");
        }
      };
      await requestCancellation();
      const cursor = await input.readCursor(exactSession.id);
      cleanup.signal.throwIfAborted();
      await waitForSessionBoundary(exactSession, cursor, Math.max(1, cleanupExpires - Date.now()), {
        accepts: matchesEvent,
        async event(event) {
          // Replaying older input resolutions must not overwrite a known current turn.
          if (observedTurnId === undefined) acceptsEvent(event);
          if (event.type === "turn.started" || event.type === "step.started") acceptsEvent(event);
          await requestCancellation();
        },
      });
    };
    try {
      await Promise.race([Promise.all([settled, cancel()]), cleanupTimeout]);
      if (sessionMismatch) throw new Error("Dispatch session mismatch");
    } catch (cause) {
      throw new TelegramProcessingTimeout(session?.id, true, cause);
    } finally {
      clearTimeout(cleanupTimer);
      cleanup.abort();
    }
    throw new TelegramProcessingTimeout(session?.id, false, error, timedOut);
  } finally {
    clearTimeout(timer);
    if (interrupt) input.signal?.removeEventListener("abort", interrupt);
  }
}
