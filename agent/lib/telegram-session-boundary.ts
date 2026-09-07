/** Bounded consumption of Eve's durable stream, including opening and cancelling the reader. */
import { AppError } from "./app-error.js";

export interface BoundaryEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface EveSessionResult {
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<BoundaryEvent>>;
  id: string;
}

export async function waitForSessionBoundary(
  session: EveSessionResult,
  startIndex: number,
  timeoutMilliseconds: number,
  observe?: { idle?: boolean; accepts?(event: BoundaryEvent): boolean; event?(event: BoundaryEvent): Promise<void> },
): Promise<number> {
  let reader: ReadableStreamDefaultReader<BoundaryEvent> | undefined;
  let cancellation: Promise<void> | undefined;
  let timedOut = false;
  let completedCursor: number | undefined;
  let cleanupReported = false;
  let deadlineTimeout: ReturnType<typeof setTimeout> | undefined;
  let refreshDeadline: (() => void) | undefined;
  const activeChildren = new Set<string>();

  function cancelReader(): Promise<void> | undefined {
    if (!reader) return;
    const activeReader = reader;
    cancellation ??= activeReader.cancel().finally(() => activeReader.releaseLock());
    return cancellation;
  }

  function reportCleanupFailure(error: unknown): void {
    if (cleanupReported) return;
    cleanupReported = true;
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_STREAM_CLEANUP_FAILED",
      eveSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const consume = async (): Promise<number> => {
    const stream = await session.getEventStream({ startIndex });
    reader = stream.getReader();
    try {
      // Opening may finish after the deadline; close that late reader instead of consuming it.
      if (timedOut) return startIndex;
      let nextEventIndex = startIndex;
      while (true) {
        const event = await reader.read();
        if (event.done) break;
        nextEventIndex += 1;
        if (observe?.accepts && !observe.accepts(event.value)) continue;
        if (observe?.idle && !timedOut) {
          const { type, data } = event.value;
          if (type === "subagent.called" || type === "subagent.started" || type === "subagent.completed") {
            if (typeof data?.callId !== "string" || !data.callId) throw new AppError(
              "AGENT_TELEGRAM_CHILD_COORDINATE_INVALID", "Не удалось проверить состояние делегированной задачи");
            if (type === "subagent.completed") activeChildren.delete(data.callId);
            else activeChildren.add(data.callId);
          }
          // Child models have their own native inactivity policy. A quiet parent waiting for
          // their result is not a stalled model and must not cancel useful delegated work.
          if (activeChildren.size) clearTimeout(deadlineTimeout);
          else refreshDeadline?.();
        }
        await observe?.event?.(event.value);
        if (
          event.value.type === "session.waiting" ||
          event.value.type === "session.completed" ||
          event.value.type === "session.failed"
        ) {
          completedCursor = nextEventIndex;
          // Cancellation does not emit subagent.completed; a confirmed parent boundary still
          // needs a bounded reader cleanup, even when the child wait suspended its idle timer.
          if (observe?.idle) { activeChildren.clear(); refreshDeadline?.(); }
          return nextEventIndex;
        }
      }
      throw new AppError(
        "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
        "Eve завершил поток без подтверждения состояния сессии Telegram",
      );
    } finally {
      try {
        await cancelReader();
      } catch (error) {
        if (completedCursor === undefined) throw error;
        // Cleanup cannot undo an observed turn boundary or lose its durable cursor.
        reportCleanupFailure(error);
      }
    }
  };

  const deadline = new Promise<number>((resolve, reject) => {
    const expire = () => {
      timedOut = true;
      if (completedCursor !== undefined) {
        reportCleanupFailure("Stream cancellation exceeded the processing deadline");
        resolve(completedCursor);
      } else {
        reject(new AppError(
          "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT",
          "Eve не сообщил состояние сессии за отведённое время. Отправьте сообщение ещё раз",
        ));
      }
      // consume owns cancellation and its rejection; the queue must not wait for stuck cleanup.
      void cancelReader();
    };
    refreshDeadline = () => { clearTimeout(deadlineTimeout); deadlineTimeout = setTimeout(expire, timeoutMilliseconds); };
    refreshDeadline();
  });
  try {
    return await Promise.race([consume(), deadline]);
  } finally {
    clearTimeout(deadlineTimeout);
  }
}
