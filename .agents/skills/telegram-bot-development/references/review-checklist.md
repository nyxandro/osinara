# Reviewing a bot before it ships (or auditing someone else's)

**Load this when** asked to review, audit or "check before release" a Telegram bot or Mini App, or after finishing a feature. Go through it in order; for each item that fails, say what the user would experience, then the fix. Report what you checked against which Bot API version (`tgdocs.py latest`).

## 0. Current API

- [ ] `tgdocs.py latest` and `changes --since <the version the library declares or the code was written for>` read; nothing the code relies on was replaced or deprecated (`history <name>` for each method and parameter it uses).
- [ ] `find_method_support.py` run for the methods the code calls, as `method.parameter` for every parameter it relies on; a parameter the library still accepts but the method page no longer lists (kept as deprecated) is not used; raw calls, if any, live in one adapter with a comment saying why.
- [ ] No hand-rolled workaround for something the API now does natively (streaming drafts, ephemeral messages, rich messages, chat/user pickers, button styles…).

## 1. Updates and delivery (`updates-and-delivery.md`)

- [ ] Exactly one consumer per token; no polling against a webhook-enabled token.
- [ ] Webhook verifies `X-Telegram-Bot-Api-Secret-Token` in constant time.
- [ ] The webhook acknowledges fast; work runs off the request path.
- [ ] Handlers are idempotent on `update_id`; side effects (messages, charges, grants) cannot happen twice.
- [ ] `allowed_updates` lists every update type the code handles, including opt-in ones.
- [ ] Per-chat ordering preserved where conversations need it; graceful shutdown in place.

## 2. User experience (`ux-and-messaging.md`)

- [ ] `/start` explains the bot in a few lines and offers buttons; `/help` exists; deep-link payloads handled (and their absence).
- [ ] Every callback query is answered on every path, errors included.
- [ ] Navigation edits in place; no dead ends; destructive actions confirmed.
- [ ] Every user message gets a reply, including failures, in plain words with a next step.
- [ ] Long output split within limits; text not written by the bot is escaped for the parse mode or sent plain.
- [ ] Group behavior is deliberate (privacy mode, topics, anonymous admins, migrated chats).

## 3. Security and data (`security-and-privacy.md`)

- [ ] Token only in server-side secrets; not in logs, errors, client code or file URLs handed out.
- [ ] Mini App `initData` validated on the server with an age bound; sessions short-lived.
- [ ] Callback data, payloads and all user input validated; authorization re-checked server-side for every action.
- [ ] Group permissions checked from Telegram, not from message content.
- [ ] Privacy policy matches what is stored; data minimal, deletable on request, encrypted at rest.
- [ ] LLM bots: untrusted text treated as data; no irreversible action on model say-so (`ai-bots.md`).

## 4. Limits and stability (`limits-and-performance.md`, `errors-and-edge-cases.md`)

- [ ] 429 handled by waiting `retry_after`; broadcasts are resumable jobs with pacing and a stop switch.
- [ ] Errors classified: blocked/deactivated users marked, migrated chats updated, transient errors retried with bounds, permanent ones not retried.
- [ ] Timeouts on every outbound call; one bad update cannot stop the process.
- [ ] File sizes checked before download; file URLs never exposed.
- [ ] `getWebhookInfo` (pending updates, last error) monitored.

## 5. Money (`payments-stars.md`) — if the bot sells anything

- [ ] Digital goods in Stars (`XTR`); physical goods through a provider.
- [ ] Pre-checkout answered within its time limit, cheaply; delivery only on `successful_payment`, idempotent on the charge id.
- [ ] Refund path revokes grants; `/paysupport` handled; terms reachable.
- [ ] If private-chat topics are enabled, the owner knows about the fee they put on every Stars purchase (developer terms 6.2.6), and they were not enabled only to stream drafts.

## 6. Product settings

- [ ] The BotFather settings the features rely on are listed for the owner (privacy mode, inline mode, menu button, Mini App domain protection, guest/management/business modes, paid broadcasts, payments).
- [ ] Commands registered with `setMyCommands` (scopes and languages as needed); description and about texts set.
