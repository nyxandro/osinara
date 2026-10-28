/**
 * One presented chunk of model-authored text on the Telegram wire.
 *
 * Export:
 * - `postTelegramPresentationChunk`: sends a plain chunk as an ordinary message and a rich chunk as
 *   a native rich message with the files it shows, so a final answer and a progress notice reach
 *   the chat the same way. A message with files Telegram refused for good goes once more without
 *   them, so one file Telegram cannot take costs no answer.
 */
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { withRefusedFiles } from "./answer-files/answer-file-delivery.js";
import type { TelegramFinalPresentationChunk } from "./telegram-final-presentation.js";
import { postTelegramPlainMessageChunk } from "./telegram-plain-messages.js";
import type { TelegramReplyParameters } from "./telegram-reply.js";
import {
  isTelegramRichMessageRefusal,
  postTelegramRichMessageChunk,
  type SentTelegramMessage,
  type TelegramRichMediaUpload,
} from "./telegram-rich-messages.js";

export async function postTelegramPresentationChunk(
  chunk: Pick<TelegramFinalPresentationChunk, "format" | "text"> & { readonly media?: readonly TelegramRichMediaUpload[] },
  channel: TelegramEventContext,
  replyParameters?: TelegramReplyParameters,
): Promise<SentTelegramMessage> {
  const media = chunk.media ?? [];
  if (chunk.format === "plain") {
    // The presentation sends every chunk with files rich; a plain message would drop them unseen.
    if (media.length > 0) throw new Error("AGENT_TELEGRAM_PLAIN_CHUNK_WITH_MEDIA: a plain message cannot carry files");
    return await postTelegramPlainMessageChunk(chunk.text, channel, replyParameters);
  }
  try {
    return await postTelegramRichMessageChunk(chunk.text, channel.telegram, channel.state, replyParameters, media);
  } catch (error) {
    if (media.length === 0 || !isTelegramRichMessageRefusal(error)) throw error;
    // Refused for good means not delivered: the same words go once more, each file replaced by a
    // line saying it could not go. A failure whose outcome is unknown is never resent.
    console.error(JSON.stringify({ code: "AGENT_ANSWER_FILES_REFUSED", files: media.length }));
    return await postTelegramRichMessageChunk(withRefusedFiles(chunk.text, media), channel.telegram, channel.state, replyParameters, []);
  }
}
