/**
 * How a private chat shows a turn while it runs: "typing" while the model thinks and tools work, and
 * Telegram's draft with the answer while the model writes it.
 *
 * Exports:
 * - `AnswerDraftTransport`, `AnswerDraftPresenter`: the two Telegram calls and one turn's presenter.
 * - `createAnswerDraftPresenter`: the presenter of one turn, showing "typing" from its creation.
 * - `AnswerDraftRegistry`, `createAnswerDraftRegistry`: the presenters of the turns that run now.
 *
 * Key constructs:
 * - Telegram counts drafts and statuses together, at most 20 calls in 5 s per chat: the draft goes
 *   at most once a second with the latest text, "typing" every four seconds and never beside it.
 * - A draft lives 30 s: one that shows a still text is sent again every twenty.
 * - A sent message removes the draft. Before one goes out the presenter stops and waits for a draft
 *   still in flight, so none lands after the message; "typing" comes back when a tool starts.
 * - A visible draft keeps a person on Android from sending a message (Telegram bug 62189, "intended
 *   behavior"), so it shows only while text is being written and never during tool work.
 * - Presentation only: a refusal with Telegram's wait silences every call until it has passed, a
 *   failure is logged once per turn, and nothing here ever fails the turn.
 * - The registry lives in the process: a turn resumed after a restart shows "typing" again when its
 *   next tool starts.
 */
import { TELEGRAM_DRAFT_KEEPALIVE_MS, TELEGRAM_DRAFT_MIN_INTERVAL_MS } from "../../config.js";
import { CHAT_ACTION_STATUS_REFRESH_MS } from "../telegram-chat-action-status.js";
import type { TelegramDraftOutcome } from "../telegram-rich-messages.js";
import { previewAnswerText } from "./answer-draft-preview.js";

const MILLISECONDS_PER_SECOND = 1_000;

export interface AnswerDraftTransport {
  draft(markdown: string): Promise<TelegramDraftOutcome>;
  /** Shows "typing"; a failure is the transport's to log. */
  typing(): Promise<void>;
}

export interface AnswerDraftPresenter {
  /** The step's visible text written so far; returns at once. */
  text(textSoFar: string): void;
  /** A tool starts: "typing" again. Also resumes a presenter paused for a person. */
  toolsStarted(): void;
  /** A message is about to go out: nothing more shows until the turn moves on. */
  beforeMessage(): Promise<void>;
  /** The turn waits for a person: nothing shows. */
  pause(): void;
  close(): void;
}

type State = "closed" | "paused" | "quiet" | "typing" | "writing";

function failureDetails(failure: unknown): Record<string, number | string> {
  if (failure instanceof Error) return { error: failure.message };
  const outcome = failure as Extract<TelegramDraftOutcome, { ok: false }>;
  return {
    ...(outcome.description === undefined ? {} : { description: outcome.description }),
    providerStatus: outcome.providerStatus,
    ...(outcome.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: outcome.retryAfterSeconds }),
  };
}

export function createAnswerDraftPresenter(input: {
  /** Whether a tool shows its own status in the chat now ("recording a voice message"). */
  readonly statusBusy: () => boolean;
  readonly transport: AnswerDraftTransport;
}): AnswerDraftPresenter {
  let state: State = "typing";
  let latest: string | null = null;
  let shown: string | null = null;
  let lastDraftAt = Number.NEGATIVE_INFINITY;
  let silentUntil = 0;
  let failureLogged = false;
  let inFlight: Promise<void> | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    for (const timer of [typingTimer, draftTimer, keepAliveTimer]) if (timer !== null) clearTimeout(timer);
    typingTimer = null;
    draftTimer = null;
    keepAliveTimer = null;
  }

  function logFailure(failure: unknown): void {
    if (failureLogged) return;
    failureLogged = true;
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_DRAFT_UPDATE_FAILED", ...failureDetails(failure) }));
  }

  function typingTick(): void {
    typingTimer = null;
    if (state !== "typing") return;
    if (Date.now() >= silentUntil && !input.statusBusy()) void input.transport.typing().catch(logFailure);
    typingTimer = setTimeout(typingTick, CHAT_ACTION_STATUS_REFRESH_MS);
  }

  function startTyping(): void {
    clearTimers();
    latest = null;
    shown = null;
    state = "typing";
    typingTick();
  }

  function scheduleDraft(): void {
    if (draftTimer !== null || inFlight !== null) return;
    const now = Date.now();
    draftTimer = setTimeout(flushDraft, Math.max(0, lastDraftAt + TELEGRAM_DRAFT_MIN_INTERVAL_MS - now, silentUntil - now));
  }

  function keepAlive(): void {
    keepAliveTimer = null;
    if (state !== "writing" || shown === null) return;
    if (inFlight !== null || Date.now() < silentUntil) {
      keepAliveTimer = setTimeout(keepAlive, TELEGRAM_DRAFT_MIN_INTERVAL_MS);
      return;
    }
    sendDraft(shown);
  }

  function sendDraft(preview: string): void {
    const sentText = latest;
    lastDraftAt = Date.now();
    shown = preview;
    if (keepAliveTimer !== null) clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(keepAlive, TELEGRAM_DRAFT_KEEPALIVE_MS);
    inFlight = (async () => {
      try {
        const outcome = await input.transport.draft(preview);
        if (outcome.ok) return;
        if (outcome.retryAfterSeconds !== undefined) {
          silentUntil = Date.now() + outcome.retryAfterSeconds * MILLISECONDS_PER_SECOND;
        }
        logFailure(outcome);
      } catch (error) {
        logFailure(error);
      }
    })().finally(() => {
      inFlight = null;
      if (state === "writing" && latest !== sentText) scheduleDraft();
    });
  }

  function flushDraft(): void {
    draftTimer = null;
    if ((state !== "typing" && state !== "writing") || latest === null) return;
    if (Date.now() < silentUntil) {
      scheduleDraft();
      return;
    }
    const preview = previewAnswerText(latest);
    if (preview === null) return;
    if (state === "typing") {
      if (typingTimer !== null) clearTimeout(typingTimer);
      typingTimer = null;
      state = "writing";
    }
    sendDraft(preview);
  }

  typingTick();

  return {
    text(textSoFar) {
      if (state === "closed" || state === "paused") return;
      if (state === "quiet") startTyping();
      latest = textSoFar;
      scheduleDraft();
    },
    toolsStarted() {
      if (state === "closed") return;
      startTyping();
    },
    async beforeMessage() {
      if (state === "closed") return;
      clearTimers();
      latest = null;
      shown = null;
      if (state !== "paused") state = "quiet";
      if (inFlight !== null) await inFlight;
    },
    pause() {
      if (state === "closed") return;
      clearTimers();
      state = "paused";
    },
    close() {
      clearTimers();
      state = "closed";
    },
  };
}

export interface AnswerDraftRegistry {
  /** Creates the turn's presenter unless it already has one. */
  start(turnId: string, create: () => AnswerDraftPresenter): void;
  text(turnId: string, textSoFar: string): void;
  /** Whether the turn has a presenter, which now shows "typing". */
  toolsStarted(turnId: string): boolean;
  beforeMessage(turnId: string): Promise<void>;
  pause(turnId: string): void;
  /** Stops the turn's presenter after any draft in flight has landed, so none follows a message. */
  close(turnId: string): Promise<void>;
}

export function createAnswerDraftRegistry(): AnswerDraftRegistry {
  const presenters = new Map<string, AnswerDraftPresenter>();
  return {
    start(turnId, create) {
      if (!presenters.has(turnId)) presenters.set(turnId, create());
    },
    text(turnId, textSoFar) {
      presenters.get(turnId)?.text(textSoFar);
    },
    toolsStarted(turnId) {
      const presenter = presenters.get(turnId);
      presenter?.toolsStarted();
      return presenter !== undefined;
    },
    async beforeMessage(turnId) {
      await presenters.get(turnId)?.beforeMessage();
    },
    pause(turnId) {
      presenters.get(turnId)?.pause();
    },
    async close(turnId) {
      const presenter = presenters.get(turnId);
      presenters.delete(turnId);
      if (presenter === undefined) return;
      await presenter.beforeMessage();
      presenter.close();
    },
  };
}
