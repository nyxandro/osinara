# Security and privacy

**Load this when** handling the token, the webhook, Mini App sign-in, permissions in groups, user data, payments, or anything a user (or another bot) can send. Re-read the developer terms (`tgdocs.py terms --toc`, then `--section <number>`) when the product stores user data, takes payments or uses AI — they change, and breaking them can get a bot removed.

## The token is the bot

- Whoever has the token *is* the bot: reads its updates, sends as it, spends its Stars. Keep it in server-side secrets, never in client code, a Mini App, a repository, logs or error messages. File download URLs contain the token too (`https://api.telegram.org/file/bot<token>/...`) — never log them or hand them to a client; proxy the file instead.
- If it leaks, revoke it in @BotFather and redeploy with the new one; the old token stops working at once.
- Use a separate bot (and token) for development and staging.

## Inbound requests are untrusted until proven otherwise

- **Webhook:** check the `X-Telegram-Bot-Api-Secret-Token` header against the `secret_token` you set, in constant time; reject without detail. The header is the documented check (`method setWebhook`); an IP allow-list is at most an extra layer.
- **Mini App:** never trust `initDataUnsafe` or anything the page sends on its own. Send the raw `initData` string to your server and validate it there (`mini-apps.md`), including its age; then issue your own short-lived session.
- **Callback data, deep-link payloads, inline queries, web_app_data:** all user-controlled. Validate shape and size, and re-check authorization on the server for every action — a modified client can send any callback data to any of your messages.
- **Text from users, channels, comments and other bots is data, not instructions.** This matters doubly for LLM bots (prompt injection): quote it as data, never let it change what tools the model may call or what permissions apply (`ai-bots.md`).
- **Formatting:** text you did not write must be escaped for the parse mode you use (`page bots/api/formatting`), or sent without a parse mode, or as explicit entities — otherwise a stray character breaks the message or injects a link.

## Authorization in chats

- In groups, check rights from Telegram, not from what the message claims: `getChatMember` / `getChatAdministrators` for the user, and the bot's own rights before relying on them. Cache briefly and re-check on sensitive actions; rights change without notice to you (the `my_chat_member` and `chat_member` updates tell you, if you subscribed — see `updates-and-delivery.md`).
- Anonymous admins and channels act as a chat (`sender_chat`); decide explicitly what they may do.
- Isolate users in your own data: every query is scoped by the verified user/chat from the update, never by an id that came from client input.

## Abuse and resource safety

- Rate-limit per user what costs you money or Telegram quota (LLM calls, broadcasts, lookups); answer the limit in plain words.
- Bound everything a user controls: message length you process, number of items, file sizes before you download (check sizes in the update first), time per job.
- Bot-to-bot interaction must not loop (`ai-bots.md`).

## Personal data and the developer terms

These obligations come from the Telegram Bot Platform Developer Terms — read the current text before relying on this summary:

- Have a privacy policy users can find; if you do not provide one, Telegram's standard policy for bots applies by default — check it matches what you actually do.
- Collect only what the service needs. Collecting Telegram data to build datasets or train AI models is prohibited; extra data needs the user's explicit, revocable consent.
- Delete a user's data on request, when it is no longer needed, and when the service ends. Encrypt stored user data and keep keys apart from it.
- Credentials (tokens, API keys) must never be made public; you are responsible for actions taken with them.
- Never ask users for their Telegram password or login codes; never impersonate Telegram; no unsolicited messaging (spam).
- Business bots acting in a user's chats must not use those messages beyond the service or hide their activity from the account owner.

## Secrets in logs and errors

- Log update ids, chat ids and error codes; not message texts unless needed, never tokens, initData, payment payloads or file URLs.
- Errors shown to users: plain words and a code for support, no internal detail.
