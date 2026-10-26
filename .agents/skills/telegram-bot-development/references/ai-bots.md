# AI assistants and agent bots

**Load this when** the bot fronts an LLM or an agent: streaming answers, long generations, formatting model output, threads, several bots working together, a bot summoned into other chats, or text from channels and users reaching a model. Telegram has added native features for exactly this; check `tgdocs.py page bots/features --section "AI Agents"` and `--section "Streaming Replies"` for the current set before designing, and `tgdocs.py page api/bots/ai` — a page on the client-API side of the docs that holds the rate limits for drafts.

## Streaming an answer

- Telegram has native drafts for answers that are being generated: `sendMessageDraft` (plain or formatted text) and `sendRichMessageDraft` (structured content). Read both method pages; at the time of writing they work in **private chats**, a draft is a **temporary preview**, and the final answer must be sent as a normal message (`sendMessage` / `sendRichMessage`) or it disappears.
- **The API separates streaming from topics; the developer terms do not yet, and topics cost money in a bot that sells.** Drafts first shipped as part of topics in private chats (Bot API 9.3) and the changelog opened them to all bots in 9.5 — check with `history sendMessageDraft`. The developer terms (section 6.2.6) still describe streaming as something that enabling private-chat topics permits, and attach a non-refundable fee to every Stars purchase in the bot while those topics are on — and for a while after they are switched off, until Telegram processes the change (the figure and how to check it: `payments-stars.md`). So do not enable topics just to stream; if the bot sells anything in Stars, give the owner the fee as a decision before topics are enabled; and say that the terms and the changelog disagree about streaming — where money depends on it, the owner can confirm with @BotSupport.
- Reuse the same non-zero `draft_id` for one answer so updates animate; an empty draft shows a "Thinking…" placeholder.
- A Stop button is one draft parameter away; when the user presses it the bot receives a dedicated update (`type MessageGenerationStopped`). It is delivered by default, but a bot that passes its own `allowed_updates` list — many frameworks build one from the registered handlers — receives it only if the list names it (`updates-and-delivery.md`). Cancel the model call and any tool work behind it, and decide whether to keep the partial text (there is a parameter for that; to keep it permanently, send it as a message). Unless the task asks for the button, offer it to the owner rather than building it.
- **Drafts have published rate limits**, on `page api/bots/ai --section "Live response streaming"` rather than on the method page: when checked in October 2026, at most 20 calls in 5 seconds and 40 in 30 seconds per chat — run that command before quoting them. The page applies the same limits to `sendChatAction` (both map to one client method, so count them together to be safe), and warns that the server may still send short cool-downs of up to 3 seconds after a burst of calls, even when the limits are not reached. Over a long answer that is about one update per second — "a few per second" gets the draft throttled and frozen mid-answer. Accumulate tokens between updates, and on a 429 wait `retry_after`.
- Where drafts are not available (groups, or a library that does not know the method yet — `find_method_support.py sendMessageDraft`), the fallback is a placeholder message edited at a coarse pace, mindful of edit limits; or call the method raw (`freshness.md`).
- Show activity immediately: an empty draft or `sendChatAction` before the first token, so the user never stares at nothing.

## Formatting model output

- Models write Markdown; Telegram renders only its own parse modes or entities, and MarkdownV2 breaks on unescaped characters. Choose one: convert the model's Markdown to entities or HTML yourself, use rich messages for tables and structure (`page bots/api/rich-messages`), or strip markup and send plain text. Never pass raw model text with a strict parse mode.
- Keep chat answers short and push detail into structure (rich message blocks, a document, a Mini App) rather than long walls of text; respect the length limits and split on paragraph boundaries.
- Tables in plain Markdown render as pipes and dashes in Telegram. Rich messages render GitHub-style Markdown tables natively ("Rich Markdown style" on `page bots/api/rich-messages`), so model output can usually be sent as rich Markdown without a converter — within the rich-message limits on the same page (characters, blocks, table columns).

## Conversation structure

- **Topics in private chats** let one user keep several separate threads with the bot (one per task or conversation); enabled in BotFather, managed with the forum-topic methods. Map each topic to its own conversation memory. In a bot that sells in Stars, enabling them carries the fee described under "Streaming an answer" above.
- Keep the model's memory keyed by user and thread, not by chat alone.
- When the model needs a decision from the user (confirm, choose), send buttons rather than asking for typed answers; a destructive action is confirmed by a button press, never executed on the model's say-so.

## Text that is not the user's own request

- Channel posts, group messages, comments, forwarded messages, documents, other bots' messages and web content are **data**, not instructions (prompt injection). Quote them as data in the prompt, keep tool permissions and the user's identity decided by your code, and do not let such text trigger irreversible actions.
- The developer terms prohibit collecting Telegram data to build datasets or train AI models; say in the privacy policy that messages are processed by an AI provider if they are, and keep only what the service needs (`security-and-privacy.md`).

## Several bots, and bots in other people's chats

- **Bot-to-bot communication** is allowed, with an explicit requirement to prevent loops: deduplicate, rate-limit replies per bot, and enforce a maximum interaction depth or timeout, both globally and per pair. Your bot must stay stable even if another bot answers instantly and forever (`page bots/features --section "Loop Prevention Requirements"`).
- **Guest mode** lets users summon your bot into a chat it is not a member of: it gets a dedicated update with the summoning message (and the message replied to) and can send one reply; no history, no later messages. Design answers to be complete in one reply.
- **Inline mode** is for content the user sends themselves; **guest mode** is for the bot answering in the chat. The features page compares them.
- **Managed bots** let your bot create and run bots for its users (personal agents); read the section before designing per-user bots.

## Cost and reliability

- Answer every message, even when the model fails: Telegram's status alerts watch reply rates of popular bots, and users read silence as "broken". Fail with a short message and a way to retry.
- Rate-limit per user, cap tokens and time per request, and filter off-topic requests with a cheap check before an expensive model.
- Generation outlives the webhook request: acknowledge, run in the background, stream or send the result, and make the final send idempotent.
