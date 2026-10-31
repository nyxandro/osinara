/**
 * Native Telegram Rich Message transport for model-authored output.
 *
 * Exports:
 * - `startTelegramRichThinkingDraft`: displays Telegram's native ephemeral thinking block.
 * - `postTelegramRichMessage`: persists completed rich output and records group anchors.
 * - `SentTelegramMessage`: confirmed Telegram identity for each delivered rich chunk.
 * - `TelegramRichMediaUpload`: a file uploaded with a chunk and placed by its media block.
 * - `SentRichMedia`: the Telegram file an upload became, which a later edit must name again.
 * - `richMediaBlockLines`: the `tg://` media blocks of a text, each on a line of its own, outside code.
 * - `telegramRichMessageRequest`, `sentRichMediaOf`: the request of a rich message with its files and
 *   the Telegram files they became, for a sender with its own transport (a reminder).
 * - `isTelegramRichMessageRefusal`: a definitive refusal of the message, told apart from a failure
 *   whose outcome is unknown.
 *
 * Key constructs:
 * - One stable non-zero draft ID per private chat/topic and turn.
 * - Telegram Bot API 10.1 `sendRichMessageDraft` and `sendRichMessage` validation.
 * - Final-delivery ambiguity diagnostics without automatic retries.
 * - First-chunk group replies anchored to a verified inbound message.
 * - A chunk with files goes as one multipart request: Bot API 10.2 `InputRichMessage.media` names
 *   each `tg://<kind>?id=` of the text and points at its `attach://` part. Telegram reads the files
 *   before it answers, so the upload has its own longer timeout.
 */
import { createHash } from "node:crypto";

import { callTelegramApi, type TelegramApiResponse } from "../runtime/telegram/api.js";
import type { TelegramChannelState, TelegramHandle } from "../runtime/telegram/channel-types.js";
import type { TelegramChatType } from "../runtime/telegram/inbound.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS, TELEGRAM_RICH_MEDIA_UPLOAD_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import { markdownCodeRanges, readMarkdownTree } from "./markdown-syntax.js";
import type { TelegramReplyParameters } from "./telegram-reply.js";
import { formatTelegramRichMessages } from "./telegram-rich-markdown.js";

const TELEGRAM_DRAFT_ID_MODULUS = 2_147_483_647;
const TELEGRAM_THINKING_CUSTOM_EMOJI_ID = "5535034915403333642";
const TELEGRAM_THINKING_HTML = `<tg-thinking><tg-emoji emoji-id="${TELEGRAM_THINKING_CUSTOM_EMOJI_ID}"></tg-emoji> Думаю…</tg-thinking>`;
const TELEGRAM_CHAT_TYPES = new Set<TelegramChatType>([
  "channel",
  "group",
  "private",
  "supergroup",
]);

type TelegramRichTarget = Pick<
  TelegramHandle,
  "chatId" | "chatType" | "messageThreadId"
>;

type TelegramRichAnchorState = Pick<
  TelegramChannelState,
  "chatType" | "conversationId"
>;
type TelegramApiBody = NonNullable<
  Parameters<typeof callTelegramApi>[0]["body"]
>;

export interface SentTelegramMessage {
  readonly chatType: TelegramChatType;
  /** The Telegram file each uploaded media id became; set for a rich chunk sent with files. */
  readonly media?: readonly SentRichMedia[];
  readonly messageId: string;
}

/** An uploaded file as Telegram now holds it: an edit of the message must name it again. */
export interface SentRichMedia {
  readonly fileId: string;
  readonly id: string;
  readonly kind: TelegramRichMediaUpload["kind"];
}

/** A file uploaded with a rich message and placed in it by a `tg://<kind>?id=<id>` media block. */
export interface TelegramRichMediaUpload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly id: string;
  readonly kind: "audio" | "document" | "photo" | "video";
  readonly mediaType: string;
  readonly sha256: string;
}

function draftId(target: TelegramRichTarget, turnId: string): number {
  const thread =
    target.messageThreadId === undefined ? "" : String(target.messageThreadId);
  const digest = createHash("sha256")
    .update(target.chatId)
    .update(":")
    .update(thread)
    .update(":")
    .update(turnId)
    .digest();
  return (digest.readUInt32BE(0) % TELEGRAM_DRAFT_ID_MODULUS) + 1;
}

function requireTelegramBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_CONFIG_MISSING",
      "Не задан Telegram bot token для отправки форматированного ответа",
    );
  }
  return botToken;
}

function numericChatId(
  target: TelegramRichTarget,
  privateOnly: boolean,
): number | string {
  const numeric = Number(target.chatId);
  if (
    Number.isSafeInteger(numeric) &&
    numeric !== 0 &&
    (!privateOnly || numeric > 0)
  ) {
    return numeric;
  }
  if (!privateOnly && /^@[A-Za-z][A-Za-z0-9_]{3,}$/u.test(target.chatId)) {
    return target.chatId;
  }
  throw new AppError(
    "AGENT_TELEGRAM_RICH_CHAT_ID_INVALID",
    "Telegram передал некорректный идентификатор чата",
  );
}

function telegramRichFetch(timeoutMs: number) {
  return (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetch(request, { ...init, signal });
  };
}

const TELEGRAM_BAD_REQUEST_STATUS = 400;
const TELEGRAM_DESCRIPTION_MAX_LENGTH = 200;

function addStableErrorCode(error: Error, code: string): void {
  // DOMException exposes a getter-only message, so attach diagnostics without replacing the cause.
  Object.defineProperty(error, "message", {
    configurable: true,
    value: `${code}: ${error.message}`,
    writable: true,
  });
}

async function requestTelegramRichApi(
  method: "sendRichMessage" | "sendRichMessageDraft",
  payload: { readonly body: TelegramApiBody } | { readonly form: FormData },
): Promise<TelegramApiResponse> {
  const transportCode =
    method === "sendRichMessage"
      ? "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS"
      : "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED";
  let response: TelegramApiResponse;
  try {
    response = await callTelegramApi({
      ...payload,
      botToken: requireTelegramBotToken(),
      fetch: telegramRichFetch("form" in payload ? TELEGRAM_RICH_MEDIA_UPLOAD_TIMEOUT_MS : TELEGRAM_API_REQUEST_TIMEOUT_MS),
      method,
    });
  } catch (error) {
    // A final network failure is ambiguous because Telegram may have accepted the message.
    console.error(
      JSON.stringify({
        code: transportCode,
        errorName: error instanceof Error ? error.name : "UnknownError",
        method,
      }),
    );
    if (error instanceof Error) addStableErrorCode(error, transportCode);
    throw error;
  }

  if (
    response.ok &&
    typeof response.body === "object" &&
    response.body !== null &&
    "ok" in response.body &&
    response.body.ok === true
  ) {
    return response;
  }
  const rejectionCode =
    method === "sendRichMessage"
      ? "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED"
      : "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED";
  // Telegram's own reason names what it refused. It is an error text, but it may quote a tag of
  // the message, so only its start is kept.
  const description = typeof response.body === "object" && response.body !== null &&
    "description" in response.body && typeof response.body.description === "string"
    ? response.body.description.slice(0, TELEGRAM_DESCRIPTION_MAX_LENGTH)
    : null;
  console.error(
    JSON.stringify({
      code: rejectionCode,
      method,
      providerStatus: response.status,
      ...(description === null ? {} : { description }),
    }),
  );
  throw new AppError(
    rejectionCode,
    method === "sendRichMessage"
      ? "Telegram не принял форматированный ответ. Попробуйте отправить запрос ещё раз"
      : "Telegram не принял потоковое обновление ответа. Попробуйте отправить запрос ещё раз",
    { details: { providerStatus: response.status, ...(description === null ? {} : { description }) } },
  );
}

/**
 * Whether Telegram refused the message itself (HTTP 400): it was not delivered, so a changed
 * message may go instead without any risk of a duplicate. A rate limit, a server error or a lost
 * response is never such a refusal.
 */
export function isTelegramRichMessageRefusal(error: unknown): boolean {
  return error instanceof AppError && error.code === "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED" &&
    error.details?.providerStatus === TELEGRAM_BAD_REQUEST_STATUS;
}

function requireDraftSuccess(response: TelegramApiResponse): void {
  const body = response.body as { result?: unknown };
  if (body.result === true) return;
  console.error(
    JSON.stringify({
      code: "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED",
      method: "sendRichMessageDraft",
      providerStatus: response.status,
    }),
  );
  throw new AppError(
    "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED",
    "Telegram вернул некорректное подтверждение потокового ответа",
  );
}

function requireSentMessage(
  response: TelegramApiResponse,
): SentTelegramMessage {
  const body = response.body as {
    result?: {
      chat?: { type?: unknown };
      message_id?: unknown;
    };
  };
  const messageId = body.result?.message_id;
  const chatType = body.result?.chat?.type;
  if (
    Number.isSafeInteger(messageId) &&
    Number(messageId) > 0 &&
    typeof chatType === "string" &&
    TELEGRAM_CHAT_TYPES.has(chatType as TelegramChatType)
  ) {
    return {
      chatType: chatType as TelegramChatType,
      messageId: String(messageId),
    };
  }
  console.error(
    JSON.stringify({
      code: "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
      method: "sendRichMessage",
      providerStatus: response.status,
    }),
  );
  throw new AppError(
    "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
    "Telegram принял запрос, но не подтвердил идентификатор отправленного сообщения",
  );
}

function richTargetFields(
  target: TelegramRichTarget,
  privateOnly: boolean,
  replyParameters?: TelegramReplyParameters,
): TelegramApiBody {
  return {
    chat_id: numericChatId(target, privateOnly),
    ...(target.messageThreadId === undefined
      ? {}
      : { message_thread_id: target.messageThreadId }),
    ...(replyParameters === undefined
      ? {}
      : { reply_parameters: replyParameters }),
  };
}

function richBody(
  target: TelegramRichTarget,
  richMessage: TelegramApiBody,
  privateOnly: boolean,
  replyParameters?: TelegramReplyParameters,
): TelegramApiBody {
  return { ...richTargetFields(target, privateOnly, replyParameters), rich_message: richMessage };
}

export async function startTelegramRichThinkingDraft(
  target: TelegramRichTarget,
  turnId: string,
): Promise<void> {
  if (target.chatType !== "private") return;
  if (!turnId) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_TURN_ID_INVALID",
      "Не удалось связать потоковый ответ с текущим запросом",
    );
  }
  const response = await requestTelegramRichApi("sendRichMessageDraft", {
    body: {
      ...richBody(target, { html: TELEGRAM_THINKING_HTML }, true),
      draft_id: draftId(target, turnId),
    },
  });
  requireDraftSuccess(response);
}

const MEDIA_BLOCK_KINDS: ReadonlySet<string> = new Set(["audio", "document", "photo", "video"]);
const MEDIA_BLOCK_LINE_PATTERN = /^!\[\]\(tg:\/\/(audio|document|photo|video)\?id=([A-Za-z0-9_-]{1,64})(?: "(?:[^"\\\n]|\\.)*")?\)$/gmu;

/**
 * The `tg://` media blocks of a rich text in order, as the lines the presentation wrote. A line that
 * looks like one inside code is the model's text, shown as code: it is no block.
 */
export function richMediaBlockLines(markdown: string): Array<{ id: string; kind: string; range: { end: number; start: number } }> {
  const code = markdownCodeRanges(readMarkdownTree(markdown));
  return [...markdown.matchAll(MEDIA_BLOCK_LINE_PATTERN)]
    .filter((match) => !code.some((range) => match.index >= range.start && match.index < range.end))
    .map((match) => ({ id: match[2]!, kind: match[1]!, range: { end: match.index + match[0].length, start: match.index } }));
}

/** Telegram's file of one returned media block; a photo's largest size comes last. */
function blockFileId(block: Record<string, unknown>): string | null {
  const file = block.type === "photo" && Array.isArray(block.photo) ? block.photo.at(-1) : block[String(block.type)];
  const fileId = typeof file === "object" && file !== null ? (file as { file_id?: unknown }).file_id : undefined;
  return typeof fileId === "string" && fileId.length > 0 ? fileId : null;
}

/** The returned media blocks in document order, nested ones (a collapsed answer) included. */
function returnedMediaBlocks(value: unknown, found: Array<{ fileId: string | null; kind: string }> = []) {
  if (Array.isArray(value)) {
    for (const item of value) returnedMediaBlocks(item, found);
  } else if (typeof value === "object" && value !== null) {
    const block = value as Record<string, unknown>;
    if (typeof block.type === "string" && MEDIA_BLOCK_KINDS.has(block.type)) {
      found.push({ fileId: blockFileId(block), kind: block.type });
    } else {
      for (const nested of Object.values(block)) returnedMediaBlocks(nested, found);
    }
  }
  return found;
}

/**
 * Telegram answers with the message's blocks in the order of the text, so the n-th media block is
 * the n-th `tg://` block written. A mismatch leaves the message without known files: the delivery
 * stands, only a later edit of the message cannot name its files again.
 */
export function sentRichMediaOf(
  markdown: string,
  media: readonly TelegramRichMediaUpload[],
  response: TelegramApiResponse,
): readonly SentRichMedia[] | undefined {
  const uploaded = new Map(media.map((upload) => [upload.id, upload]));
  const written = richMediaBlockLines(markdown).filter((block) => uploaded.get(block.id)?.kind === block.kind);
  const returned = returnedMediaBlocks((response.body as { result?: { rich_message?: unknown } }).result?.rich_message);
  const sent = new Map<string, SentRichMedia>();
  const matches = written.length === returned.length && written.every((line, index) => {
    const block = returned[index]!;
    if (block.kind !== line.kind || block.fileId === null) return false;
    if (!sent.has(line.id)) sent.set(line.id, { fileId: block.fileId, id: line.id, kind: block.kind as SentRichMedia["kind"] });
    return true;
  });
  if (matches && sent.size === uploaded.size) return [...sent.values()];
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_RICH_MEDIA_RECEIPT_MISMATCH",
    returned: returned.length,
    written: written.length,
  }));
  return undefined;
}

function richMessageOf(markdown: string, media: readonly TelegramRichMediaUpload[]): TelegramApiBody {
  return media.length === 0
    ? { markdown }
    : { markdown, media: media.map((upload) => ({ id: upload.id, media: { media: `attach://${upload.id}`, type: upload.kind } })) };
}

/**
 * One rich message as Telegram takes it: a JSON body without files, multipart with them. `fields`
 * are the message's other parameters (chat, topic, reply).
 */
export function telegramRichMessageRequest(
  fields: TelegramApiBody,
  markdown: string,
  media: readonly TelegramRichMediaUpload[],
): { readonly body: TelegramApiBody } | { readonly form: FormData } {
  const body = { ...fields, rich_message: richMessageOf(markdown, media) };
  return media.length === 0 ? { body } : { form: multipartBody(body, media) };
}

/** The JSON fields of a rich message as multipart text fields, with each file as its own part. */
function multipartBody(body: TelegramApiBody, media: readonly TelegramRichMediaUpload[]): FormData {
  const form = new FormData();
  for (const [field, value] of Object.entries(body)) {
    form.set(field, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const upload of media) {
    form.set(upload.id, new Blob([Buffer.from(upload.bytes)], { type: upload.mediaType }), upload.fileName);
  }
  return form;
}

export async function postTelegramRichMessage(
  markdown: string,
  target: TelegramRichTarget,
  state?: TelegramRichAnchorState,
  replyParameters?: TelegramReplyParameters,
): Promise<SentTelegramMessage[]> {
  const chunks = formatTelegramRichMessages(markdown);
  const sentMessages: SentTelegramMessage[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const sent = await postTelegramRichMessageChunk(
      chunk,
      target,
      state,
      index === 0 ? replyParameters : undefined,
    );
    sentMessages.push(sent);
  }
  return sentMessages;
}

export async function postTelegramRichMessageChunk(
  markdown: string,
  target: TelegramRichTarget,
  state?: TelegramRichAnchorState,
  replyParameters?: TelegramReplyParameters,
  media: readonly TelegramRichMediaUpload[] = [],
): Promise<SentTelegramMessage> {
  const response = await requestTelegramRichApi(
    "sendRichMessage",
    telegramRichMessageRequest(richTargetFields(target, false, replyParameters), markdown, media),
  );
  const sent = requireSentMessage(response);

  // `telegram.post` anchors a group conversation (`runtime/telegram/handle.ts`); raw rich delivery
  // mirrors that contract.
  if (state) {
    if (state.chatType === null) state.chatType = sent.chatType;
    if (sent.chatType === "group" || sent.chatType === "supergroup") {
      state.conversationId = sent.messageId;
    }
  }
  if (media.length === 0) return sent;
  const sentMedia = sentRichMediaOf(markdown, media, response);
  return sentMedia === undefined ? sent : { ...sent, media: sentMedia };
}
