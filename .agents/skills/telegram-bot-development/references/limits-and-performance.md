# Limits, throughput, files

**Load this when** sending a lot (broadcasts, notifications), sending fast (bursts, edits in a loop, streaming), handling files, or a bot starts getting 429 errors. The published numbers below come from `page bots/faq` and method pages — re-read them (`tgdocs.py page bots/faq --section "Broadcasting to Users"`, `method sendMessage`, `method getFile`) before quoting a number: Telegram notes that limits may change and are not all published.

## Rate limits are flow control

- Any call can fail with 429 and `parameters.retry_after` (seconds). **Wait exactly that long and retry the same call.** Ignoring 429s is what gets bots restricted; hitting them occasionally does not.
- Do not slow down ordinary replies preemptively — answering a user should be immediate. Pace only what you initiate in bulk.
- Published guidance (re-check): in one chat avoid more than about one message per second; in a group, bots cannot send more than 20 messages per minute; bulk notifications are capped at about 30 messages per second unless paid broadcasts are enabled. Paid broadcasts raise the cap substantially for a per-message fee in Stars and have eligibility thresholds (balance, monthly active users) — the FAQ has the current numbers.
- Telegram's own advice when not using paid broadcasts: spread bulk sends over hours (the FAQ suggests 8–12).
- Edits count too: editing a message many times a second to fake streaming hits limits; use native drafts for generated answers (`ai-bots.md`). Drafts have limits of their own, published on `page api/bots/ai`, not on the FAQ, and shared with `sendChatAction`; the figures and how to pace a draft are in `ai-bots.md`.

## A broadcast is a job, not a loop

- Materialize the recipient list, send through a rate-limited queue with modest concurrency, honor `retry_after`, and record per-recipient status before moving on, so a crash resumes instead of restarting (and messaging people twice).
- Remove or mark recipients that answer "bot was blocked by the user" / deactivated — further sends are wasted quota.
- Have a stop switch that does not need a deploy.
- Keep your own list of users: the API does not list the people who started your bot.

## Files

- Download through `getFile` is capped (the FAQ: 20 MB); bots can upload up to a larger cap (50 MB) through the cloud API. A local Bot API server lifts both (`updates-and-delivery.md`). Check `method getFile` and the FAQ for the current numbers.
- The `file_path` you get from `getFile` is temporary and the download URL contains the token — never expose or log it.
- `file_id`s can be treated as persistent (FAQ) and are per bot: reuse them to resend without uploading again; keep the bytes yourself if you need an archive outside Telegram.
- Check sizes from the update (`file_size`) before downloading anything a user sent.

## Performance shape of a healthy bot

- Acknowledge the webhook immediately, process asynchronously, serialize per chat when order matters (`updates-and-delivery.md`).
- Reuse one HTTP client with keep-alive for all Bot API calls.
- Cache what is stable (`getMe`, chat info, `file_id`s) and refresh on the relevant update instead of asking Telegram on every message.
- Time-box slow dependencies (LLMs, databases) and tell the user something is happening (`sendChatAction`, a draft, a placeholder).
- Measure: per-method latency and error counts, 429 counts with `retry_after`, queue depth for broadcasts.
