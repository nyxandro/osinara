# Receiving updates: polling, webhooks, delivery guarantees

**Load this when** wiring how the bot receives updates, moving between polling and a webhook, deploying, scaling to several instances, shutting down, or debugging "the bot gets nothing", "the bot answers twice", "an update was lost".

Verify the details below against `tgdocs.py method getUpdates`, `method setWebhook`, `type Update` and `page bots/webhooks` — the shape is stable, parameters get added.

## Two ways in, never both

- `getUpdates` (long polling) and a webhook are mutually exclusive: while a webhook is set, `getUpdates` does not work. A developer running a local poller against the production token either fails or, after deleting the webhook, steals production traffic. One token, one consumer; use a separate test bot for development.
- Undelivered updates are kept on Telegram's side for **at most 24 hours**. A bot down for longer has lost them; reconcile from your own state, never assume the queue drained.
- Polling suits development and low-volume bots; a webhook suits production with a public HTTPS endpoint. Webhooks need a valid TLS certificate and one of the supported ports (currently 443, 80, 88, 8443 — check `setWebhook`); a self-signed certificate must be uploaded as a file.

## Delivery is at-least-once

- **Webhook:** any response other than 2xx — or no response in time — makes Telegram retry the same update later. A slow handler therefore gets the same `update_id` twice.
- **Polling:** `getUpdates` returns the earliest unconfirmed updates (up to 100); an update is confirmed by calling `getUpdates` with `offset = last processed update_id + 1`. Crash between doing the work and confirming, and the batch is processed again on restart. Frameworks that confirm the offset *before* finishing a batch (concurrent runners) turn that duplication into loss on a hard kill.
- **`update_id` is the idempotency key.** Store it with a unique constraint *before* acknowledging (`INSERT`, not `SELECT` then `INSERT` — several deliveries of one update can be in flight at once), process from your store, and make every side effect (a message, a charge, a grant) safe to repeat. No mainstream framework deduplicates for you: it needs your database.
- Do not compare `update_id`s across long gaps to decide what is "newer"; treat it as an identity.

## The webhook endpoint

- **Verify the secret.** Set `secret_token` in `setWebhook`; Telegram then sends it in the `X-Telegram-Bot-Api-Secret-Token` header. Compare in constant time, answer 401 with no body otherwise. A secret path in the URL is an older, weaker variant — the URL ends up in logs.
- **Acknowledge fast, work after.** Store the update, return 200, process off the request path (a queue or a background task). Long work inside the request means retries and duplicates.
- You may answer a webhook request with a method call in the response body, but then you cannot know whether it succeeded; use it only for fire-and-forget replies.
- `max_connections` caps concurrent deliveries (check its range and default in `setWebhook`); lower it to protect a small server, raise it for throughput.
- `ip_address` pins delivery to a fixed IP instead of DNS.

## `allowed_updates` is a subscription, not a filter in your code

- The default — an empty list — delivers all update types **except** a few opt-in ones (currently `chat_member`, `message_reaction`, `message_reaction_count`; check `setWebhook`/`getUpdates`). A bot that tracks joins or reactions and never asked for them receives nothing, with no error anywhere.
- Not passing the parameter at all keeps the **previous** setting — a redeploy does not reset it.
- New update types appear with releases (for example, an update when a user stops a streamed reply, or one per managed-bot change). Unless they are opt-in, they arrive by default — but a bot that passes an explicit list, by hand or through its framework, receives only what the list names. When you add a handler for a new type, make sure the list the bot actually sends includes it, and re-register.
- `drop_pending_updates=true` discards everything queued, including payments already made. It is a decision, not a cleanup step.

## Several instances

- One update must be handled by one worker. With a webhook behind a load balancer that holds automatically only if your store deduplicates on `update_id`; with polling, run exactly one poller and fan work out through a queue.
- Per-chat ordering matters for conversations (a reply processed before the message it answers). If you process concurrently, serialize per chat (a queue keyed by `chat_id`), not globally.

## Shutting down and deploying

- On SIGTERM/SIGINT stop taking new updates, finish or re-queue in-flight work, and (polling) confirm the offset of what was finished. A hard kill mid-batch is the classic source of duplicates or loss.
- Switching polling → webhook: stop the poller first, then `setWebhook`. Webhook → polling: `deleteWebhook` (decide about `drop_pending_updates` consciously), then start polling.
- After changing handlers for new update types, re-register `allowed_updates` as part of the deploy.

## A local Bot API server

Telegram publishes its Bot API server (`github.com/tdlib/telegram-bot-api`). Running your own removes the file size limits, allows HTTP and any port for webhooks, and returns local file paths. It is infrastructure you then operate; read the "Using a Local Bot API Server" section of `tgdocs.py page bots/api` for the current list of differences and the migration steps (`logOut` from the cloud server first).
