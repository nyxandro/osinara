/**
 * Arrival of a private question: who may ask, the 15-second window and the first private reply (#467).
 *
 * Exports:
 * - `ArrivalDecision`, `decideArrival`: what the person gets first — «Думаю…», a private refusal, or nothing
 *   because Telegram's window has passed.
 * - `PrivateQuestionArrivalDependencies`, `createPrivateQuestionArrival`: records the question and takes the
 *   decision once under its row lock; `fail` closes a question whose processing broke, showing the person
 *   the failure text in place of «Думаю…».
 *
 * Key constructs:
 * - The webhook runs the arrival right after storing the update, and the queue runs it again before the turn:
 *   whichever comes first decides, the other sees the decision. Nothing here posts to the chat.
 * - The only retry is Telegram's 429 on the first reply, once, and only if the wait still fits the window.
 * - During a release new turns do not start, so the person is told to ask again instead of waiting.
 */
import type { FamilyIdentity, RegisteredGroup } from "../family-access.js";
import { evaluateConversationAccess } from "../family-access.js";
import { PRIVATE_QUESTION_REPLY_WINDOW_MS } from "../../config.js";
import { parsePrivateQuestion, type PrivateQuestionMessage } from "./private-question-message.js";
import type { PrivateQuestionState, PrivateQuestionStore } from "./private-question-repository.js";
import type { PrivateQuestionTelegram } from "./private-question-telegram.js";
import { PRIVATE_QUESTION_CODES, PRIVATE_QUESTION_TEXTS } from "./private-question-texts.js";

const PRIVATE_QUESTION_COMMAND_NAME = "me";

export type ArrivalDecision =
  | { readonly kind: "placeholder" }
  | { readonly kind: "refuse"; readonly code: string; readonly text: string }
  | { readonly kind: "window_missed" };

export function decideArrival(input: {
  readonly chatType: "group" | "supergroup";
  readonly group: RegisteredGroup;
  readonly identity: FamilyIdentity | null;
  readonly nowMs: number;
  readonly phase: string;
  readonly question: PrivateQuestionMessage;
}): ArrivalDecision {
  if (input.nowMs - input.question.sentAt * 1000 > PRIVATE_QUESTION_REPLY_WINDOW_MS) return { kind: "window_missed" };
  if (input.phase !== "ready") {
    return { code: PRIVATE_QUESTION_CODES.updating, kind: "refuse", text: PRIVATE_QUESTION_TEXTS.updating };
  }
  const access = evaluateConversationAccess({
    actorKind: "telegram_user",
    chat: { id: input.question.chatId, type: input.chatType },
    identity: input.identity,
    registeredGroup: input.group,
  });
  if (!access.allowed) {
    return { code: PRIVATE_QUESTION_CODES.notAllowed, kind: "refuse", text: PRIVATE_QUESTION_TEXTS.notAllowed };
  }
  const isOwner = input.identity?.familyId === input.group.familyId && input.identity.role === "owner";
  if (input.group.messageMode === "owner_only" && !isOwner) {
    return { code: PRIVATE_QUESTION_CODES.notAllowed, kind: "refuse", text: PRIVATE_QUESTION_TEXTS.ownerOnly };
  }
  if (input.question.command !== PRIVATE_QUESTION_COMMAND_NAME || input.question.question === "") {
    return { code: PRIVATE_QUESTION_CODES.emptyQuestion, kind: "refuse", text: PRIVATE_QUESTION_TEXTS.emptyQuestion };
  }
  return { kind: "placeholder" };
}

export interface PrivateQuestionArrivalDependencies {
  findGroup(telegramChatId: string, chatType: "group" | "supergroup"): Promise<RegisteredGroup | null>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  now(): number;
  /** The runtime's admission phase: `ready`, `draining` or `frozen`. */
  readPhase(): Promise<string>;
  sleep(milliseconds: number): Promise<void>;
  store: PrivateQuestionStore;
  telegram: PrivateQuestionTelegram;
}

/** `ignored`: not a private question of a working group; nothing was recorded or sent. */
export type ArrivalOutcome = PrivateQuestionState | "ignored";

function log(code: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ code, ...fields }));
}

export function createPrivateQuestionArrival(dependencies: PrivateQuestionArrivalDependencies) {
  async function arrive(raw: Record<string, unknown>, updateId: string): Promise<ArrivalOutcome> {
    const question = parsePrivateQuestion(raw);
    if (question === null) return "ignored";
    const chatType = ((raw.message as { chat: { type: string } }).chat.type) as "group" | "supergroup";
    const group = await dependencies.findGroup(question.chatId, chatType);
    if (group === null) return "ignored";
    await dependencies.store.recordArrival({
      groupId: group.groupId,
      incomingEphemeralMessageId: question.incomingEphemeralMessageId,
      question: question.question,
      receivedAt: new Date(question.sentAt * 1000),
      telegramChatId: question.chatId,
      telegramUserId: question.telegramUserId,
      threadId: question.threadId,
      updateId,
    });
    const outcome = await dependencies.store.withLocked(updateId, async (row, change): Promise<ArrivalOutcome> => {
      if (row.state !== "received") return row.state;
      const decision = decideArrival({
        chatType,
        group,
        identity: await dependencies.findIdentity(question.telegramUserId),
        nowMs: dependencies.now(),
        phase: await dependencies.readPhase(),
        question,
      });
      if (decision.kind === "window_missed") {
        await change({ code: PRIVATE_QUESTION_CODES.windowMissed, state: "window_missed" });
        log(PRIVATE_QUESTION_CODES.windowMissed, { privateQuestionId: row.id, updateId });
        return "window_missed";
      }
      const text = decision.kind === "placeholder" ? PRIVATE_QUESTION_TEXTS.placeholder : decision.text;
      const send = () => dependencies.telegram.reply({
        chatId: question.chatId,
        receiverUserId: question.telegramUserId,
        replyToEphemeralMessageId: question.incomingEphemeralMessageId,
        text,
        threadId: question.threadId,
      });
      let result = await send();
      if (result.kind === "throttled") {
        const waitMs = result.retryAfterSeconds * 1000;
        const deadline = question.sentAt * 1000 + PRIVATE_QUESTION_REPLY_WINDOW_MS;
        log("AGENT_PRIVATE_QUESTION_PLACEHOLDER_THROTTLED", { privateQuestionId: row.id, retryAfterSeconds: result.retryAfterSeconds });
        if (dependencies.now() + waitMs >= deadline) {
          await change({ code: PRIVATE_QUESTION_CODES.windowMissed, state: "window_missed" });
          return "window_missed";
        }
        await dependencies.sleep(waitMs);
        result = await send();
      }
      if (result.kind !== "sent") {
        const detail = result.kind === "rejected" ? { description: result.description, status: result.status } : { status: 429 };
        console.error(JSON.stringify({ code: PRIVATE_QUESTION_CODES.placeholderRejected, privateQuestionId: row.id, ...detail }));
        await change({ code: PRIVATE_QUESTION_CODES.placeholderRejected, state: "failed" });
        return "failed";
      }
      if (decision.kind === "refuse") {
        await change({ code: decision.code, state: "refused" });
        log("AGENT_PRIVATE_QUESTION_REFUSED", { privateQuestionId: row.id, reason: decision.code });
        return "refused";
      }
      await change({ placeholderEphemeralMessageId: result.ephemeralMessageId, state: "placeholder_sent" });
      log("AGENT_PRIVATE_QUESTION_PLACEHOLDER_SENT", {
        delayMs: dependencies.now() - question.sentAt * 1000, privateQuestionId: row.id,
      });
      return "placeholder_sent";
    });
    return outcome ?? "ignored";
  }

  /**
   * Closes a question whose processing broke before its turn could answer: «Думаю…», when the person has
   * it, becomes the failure text. A question already decided is left as it is.
   */
  async function fail(updateId: string, code: string): Promise<void> {
    await dependencies.store.withLocked(updateId, async (row, change) => {
      if (!["received", "placeholder_sent", "answering"].includes(row.state)) return;
      if (row.placeholderEphemeralMessageId !== null) {
        // The final state is recorded whatever Telegram does: a question must not stay "in progress" for good.
        try {
          const edited = await dependencies.telegram.edit({
            chatId: row.telegramChatId,
            content: { text: PRIVATE_QUESTION_TEXTS.failed },
            ephemeralMessageId: row.placeholderEphemeralMessageId,
            receiverUserId: row.telegramUserId,
          });
          if (edited.kind === "rejected") {
            console.error(JSON.stringify({
              code: "AGENT_PRIVATE_QUESTION_FAILURE_NOTICE_REJECTED", description: edited.description, privateQuestionId: row.id,
            }));
          }
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_PRIVATE_QUESTION_FAILURE_NOTICE_FAILED", error: error instanceof Error ? error.message : String(error),
            privateQuestionId: row.id,
          }));
        }
      }
      await change({ code, state: "failed" });
      console.error(JSON.stringify({ code: PRIVATE_QUESTION_CODES.failed, cause: code, privateQuestionId: row.id }));
    });
  }

  return { arrive, fail };
}
