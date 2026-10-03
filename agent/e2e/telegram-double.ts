/**
 * The outside world of the application under test: Telegram's Bot API and the embedding service.
 *
 * Export:
 * - `installNetworkDouble`: replaces `globalThis.fetch` for `api.telegram.org` and the embedding
 *   host. Every Telegram call is journaled (`e2e_telegram_calls`) and answered as Telegram would;
 *   a message gets the journal row id as its message id. Every other host goes to the real network.
 *
 * Test-only.
 */
import type { Pool } from "pg";

import { E2E_TABLES } from "./e2e-tables.js";

const EMBEDDING_HOST = "memory-test";
const EMBEDDING_DIMENSIONS = 384;
const MESSAGE_METHODS = new Set(["sendMessage", "sendRichMessage", "sendPhoto", "sendDocument", "sendVoice"]);
const ACKNOWLEDGED_METHODS = new Set(["answerCallbackQuery", "sendChatAction", "setMessageReaction", "deleteMessage"]);

function chatType(chatId: number): "private" | "supergroup" {
  return chatId > 0 ? "private" : "supergroup";
}

async function requestBody(request: Request | string | URL, init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const raw = request instanceof Request ? await request.clone().text() : init?.body;
  if (typeof raw !== "string" || raw.length === 0) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export function installNetworkDouble(db: Pick<Pool, "query">): void {
  const networkFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.hostname === EMBEDDING_HOST && url.pathname === "/v1/embeddings") {
      const body = await requestBody(request, init) as { input: string[]; model: string };
      return Response.json({ model: body.model, data: body.input.map((_text, index) => ({
        index, embedding: [1, ...Array.from({ length: EMBEDDING_DIMENSIONS - 1 }, () => 0)],
      })) });
    }
    if (url.hostname !== "api.telegram.org") return await networkFetch(request, init);
    const method = url.pathname.split("/").at(-1)!;
    const body = await requestBody(request, init);
    const logged = (await db.query<{ id: number }>(
      `INSERT INTO ${E2E_TABLES.telegramCalls} (method, body) VALUES ($1, $2) RETURNING id`, [method, body],
    )).rows[0]!;
    const chatId = Number(body.chat_id);
    if (MESSAGE_METHODS.has(method)) {
      return Response.json({ ok: true, result: {
        chat: { id: chatId, type: chatType(chatId) }, date: Math.floor(Date.now() / 1_000), message_id: logged.id,
      } });
    }
    if (method === "editMessageText" || method === "editMessageReplyMarkup") {
      return Response.json({ ok: true, result: { chat: { id: chatId, type: chatType(chatId) }, message_id: body.message_id } });
    }
    if (ACKNOWLEDGED_METHODS.has(method)) return Response.json({ ok: true, result: true });
    if (method === "getChat") {
      return Response.json({ ok: true, result: { available_reactions: [], id: chatId, type: chatType(chatId) } });
    }
    return Response.json({ description: `TEST_UNEXPECTED_TELEGRAM_METHOD: ${method}`, error_code: 400, ok: false }, { status: 400 });
  };
}
