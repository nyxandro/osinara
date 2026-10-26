# Errors, edge cases, stability

**Load this when** handling Bot API errors, writing retry logic, debugging a bot that "sometimes" fails, or reviewing a bot for production.

## How to read an error

- A failed call returns `ok: false`, a human-readable `description`, an `error_code`, and sometimes `parameters` (`type ResponseParameters`). The docs say the `error_code` contents are subject to change, and descriptions are free text: **branch on the documented `parameters` first** (`retry_after`, `migrate_to_chat_id`), then on the HTTP class, and only then on description text — kept in one place, logged, and covered by a test.
- Classify before retrying. Retrying a call that is wrong (bad parameters, no rights, blocked by the user) only repeats the failure; retrying a transient one (429, 5xx, network) after the right wait is correct.

## Common failures and what they mean

The descriptions below are the ones commonly seen; they are not a stable contract.

| Situation | Typical response | What to do |
|---|---|---|
| Flood control | 429 with `retry_after` | wait exactly `retry_after`, retry the same call |
| Telegram-side trouble or maintenance | 5xx, or a 429 during server maintenance | retry with backoff, bounded; alert if it persists |
| Wrong or revoked token | 401 | stop and alert — retries will not help |
| User blocked the bot / deactivated account | 403 | mark the user unreachable, stop sending to them |
| Writing first to a user who never opened the bot | usually 403 "bot can't initiate conversation with a user"; 400 "chat not found" when the bot has never seen them at all | not a failure to retry: the user must start the bot first (a deep link, a button in a group); for a stored id, check where it came from |
| Bot removed from a group or channel | 403 | mark the chat inactive; the `my_chat_member` update tells you too |
| Group upgraded to supergroup | 400 with `migrate_to_chat_id` | update the stored chat id, resend there |
| Edit with identical content | 400 "message is not modified" | skip edits when nothing changed; treat as success |
| Message to edit/delete gone, or too old | 400 | carry on; deletion is time- and rights-limited (`method deleteMessage`) |
| Callback answered too late or twice | 400 on `answerCallbackQuery` | answer first, work after; ignore the error after the fact |
| Text cannot be parsed | 400 "can't parse entities" | the text was not escaped for the parse mode — fix escaping or drop the parse mode |
| Text or caption too long | 400 | split before sending; limits are on the method page |
| Polling while a webhook is set, or two pollers | 409 | one consumer per token; `deleteWebhook` before polling |

## Edge cases to design for

- **The same update twice** (webhook retry, crash before confirming): dedupe on `update_id` (`updates-and-delivery.md`).
- **The same button pressed twice**, or a button pressed on an old message after state changed: check current state in the handler, make actions idempotent, and answer the callback either way.
- **Messages from channels, anonymous admins, other bots, forwarded messages, messages without text** (stickers, media, service messages): handle the absence of `from` and `text` explicitly.
- **Edited messages** arrive as a separate update type; decide whether you react to them.
- **Media groups (albums)** arrive as several messages sharing a `media_group_id`; collect them before acting if they are one request.
- **Very long or empty user input**, unsupported languages, emoji and right-to-left text in names.
- **A user who never pressed Start** cannot be messaged first (the errors are in the table above); a deep link or a request in a group is the way to begin.
- **The bot's own rights change** (removed as admin, privacy mode toggled): re-check before actions that need them.
- **Long-running work outlives the request**: answer, then report the result in a new message; tell the user if it fails.
- **Clock and time zones**: dates in updates are Unix time (UTC); present them in the user's zone.

## Stability practices

- Every handler sits inside an error boundary that logs (with update id, chat id, error class) and answers the user in plain words; one bad update must not stop the process or block the queue.
- Timeouts on every outbound call; bounded retries with backoff only for transient classes; a circuit breaker or alert when a dependency keeps failing.
- Idempotent side effects, keyed on the update or on your own operation id.
- Graceful shutdown and health checks (`updates-and-delivery.md`); `getWebhookInfo` shows the last delivery error and pending update count — monitor it.
- Test with recorded updates of every type you handle, including the odd ones above.
