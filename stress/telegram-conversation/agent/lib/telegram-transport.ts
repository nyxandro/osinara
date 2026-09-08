/** Replace only Telegram network I/O. Unexpected Telegram operations fail the test. */
import { database } from "../../../../agent/lib/database.js";

const networkFetch = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  const url = new URL(request instanceof Request ? request.url : String(request));
  if (url.hostname === "memory-test" && url.pathname === "/v1/embeddings") {
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: body.model, data: body.input.map((_text: string, index: number) => ({
      index, embedding: [1, ...Array.from({ length: 383 }, () => 0)],
    })) });
  }
  if (url.hostname !== "api.telegram.org") return networkFetch(request, init);
  const method = url.pathname.split("/").at(-1);
  const body = JSON.parse(String(init?.body));
  if (method === "getChat") {
    return Response.json({ ok: true, result: { id: Number(body.chat_id), type: "supergroup", available_reactions: [] } });
  }
  if (method === "sendChatAction") return Response.json({ ok: true, result: true });
  if (method === "answerCallbackQuery") return Response.json({ ok: true, result: true });
  if (method === "editMessageText") {
    const updated = await database().query("UPDATE telegram_conversation_test_deliveries SET body=body || $2::jsonb WHERE id=$1 AND body->>'chat_id'=$3",
      [body.message_id, JSON.stringify(body), String(body.chat_id)]);
    if (updated.rowCount !== 1) throw new Error("TEST_TELEGRAM_EDIT_TARGET_MISSING");
    return Response.json({ ok: true, result: { message_id: body.message_id } });
  }
  if (method !== "sendMessage" && method !== "sendRichMessage") {
    throw new Error(`TEST_UNEXPECTED_TELEGRAM_METHOD: ${method}`);
  }
  const result = await database().query<{ id: number }>(
    "INSERT INTO telegram_conversation_test_deliveries (body) VALUES ($1) RETURNING id",
    [body],
  );
  return Response.json({ ok: true, result: {
    message_id: result.rows[0]!.id,
    chat: { id: Number(body.chat_id), type: Number(body.chat_id) > 0 ? "private" : "supergroup" },
    date: Math.floor(Date.now() / 1_000),
  } });
};
