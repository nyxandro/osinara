---
name: telegram-bot-development
description: >-
  Build, review and debug Telegram bots and Mini Apps against the live Bot API, in any language or
  framework (grammY, Telegraf, aiogram, python-telegram-bot, GramIO, Go/Rust/PHP/.NET libraries, raw
  HTTPS). The Bot API changes monthly and model knowledge lags behind it, so this skill makes you check
  the official docs and the installed library before using any method. Covers bot design and UX,
  keyboards, commands, webhooks and update delivery, security, rate limits, errors and edge cases,
  Stars payments, Mini Apps, AI bots (streaming replies, bot-to-bot) and product features. Use it
  whenever code, a question or a plan touches a Telegram bot, the Bot API, BotFather or a Mini App,
  even for a small change like a new button or command, and even if the user never says Bot API.
  Russian requests too: телеграм-бот, бот апи, вебхук, инлайн-кнопки, мини-апп, оплата звёздами.
---

# Telegram bot development on the current Bot API

The Bot API ships a release roughly every month, and a release can replace what the previous one added — parameters introduced in one version have been replaced by a new object in the very next. Your memory of method names, parameters and limits is therefore a list of things to look up, not a source. The good news: Telegram publishes its documentation as machine-readable Markdown, one page per method and type, and the installed library can be searched in a second. This skill turns both into a habit.

The skill is framework-neutral and version-neutral on purpose: it never assumes a Bot API version or a library. Work in whatever library the project already uses; the docs decide what exists, the installed library decides what the project can call.

## Tools

Both scripts live in this skill's `scripts/` directory (use the skill's base directory for the path), need only Python 3.8 or newer and its standard library, and print UTF-8 text on every platform. The commands below say `python3`; on Windows use `py -3` or `python` — `python3` there is often missing, or a Microsoft Store stub that opens the Store instead of running. On macOS the system `python3` (3.9) works.

```bash
# The live official docs (cached for a few hours; --fresh to bypass)
python3 scripts/tgdocs.py latest                       # newest Bot API version and date
python3 scripts/tgdocs.py changes --since 9.6          # everything added after a version
python3 scripts/tgdocs.py method sendMessageDraft      # one method: parameters, limits, notes
python3 scripts/tgdocs.py type InlineKeyboardButton    # one type
python3 scripts/tgdocs.py search ephemeral             # methods/types by name or summary, on every reference page
python3 scripts/tgdocs.py history receiver_user_id     # when a name was added, changed or replaced
python3 scripts/tgdocs.py page bots/features --toc     # any guide: --toc, or --section "<heading>"
python3 scripts/tgdocs.py index                        # Telegram's own map of the docs
python3 scripts/tgdocs.py terms --section 6.2.6        # one clause of the developer terms, verbatim (--toc lists them)

# What the project's installed library actually knows (any language)
python3 scripts/find_method_support.py sendMessageDraft EphemeralMessageParameters --root <project>
python3 scripts/find_method_support.py sendMessage.ephemeral_message_parameters --root <project>  # a parameter on its method
```

The scripts are conveniences for you, not dependencies of the bot: the project can be in any language. **Without Python 3** (or without network for the scripts), use the same official pages directly with any fetch tool — they are plain Markdown:

| Need | URL |
|---|---|
| map of all pages | `https://core.telegram.org/llms.txt` |
| changelog (latest version is the first `**Bot API X.Y**` line) | `https://core.telegram.org/bots/api-changelog.md` |
| method / type | `https://core.telegram.org/bots/api/methods/<name in lowercase>.md`, `.../bots/api/types/<name in lowercase>.md` |
| method and type indexes | `https://core.telegram.org/bots/api.md`, `https://core.telegram.org/bots/api/types.md`, and the pages `api.md` links to — rich-message methods and types are listed only on `https://core.telegram.org/bots/api/rich-messages.md` |
| any guide | `https://core.telegram.org/bots/<page>.md` (features, faq, webhooks, webapps, payments-stars…) |
| developer terms | `https://telegram.org/tos/bot-developers` — HTML only: with `.md` added, telegram.org silently serves the general Terms of Service instead |

and check the installed library by searching its files for the method name in camelCase and snake_case (for example with `grep -r` in `node_modules/<library>` or the virtualenv's `site-packages/<library>`).

## Before writing, reviewing or recommending any Bot API usage

1. **Find out what is current.** `latest`, then `changes --since <the version the library declares, or the one you remember>`. Read it whole — releases touch more than the headline.
2. **Read the contract of every method and type you touch** with `method` / `type`. Use the documented names and limits, not remembered ones. Unsure what exists? `search` (names and summaries; parameters and fields are not indexed). Unsure a name is still alive? `history`.
3. **Check the installed library** with `find_method_support.py` — parameters as `method.parameter`, because a bare name found somewhere in the library says nothing about the method you call. If it does not know the method, prefer a library release that does; otherwise call it raw through the library, in one adapter. If it still accepts something the method page no longer lists, do not use it (details and per-library escape hatches: `references/freshness.md`).
4. **Before saying "Telegram can't do that"**, read `page bots/features --toc` and `search` — capabilities appear there first.
5. **Say what you checked** in your answer: the Bot API version and date, and whether the installed library supports what you used. If the docs were unreachable, say so and mark the result as unverified.

Do this even for small changes; a one-line call with a renamed parameter fails just as hard as a big feature.

## Ground rules that hold across versions

These change rarely; each has a reason and a reference with the detail. Still confirm the specifics (limits, parameter names) on the method pages.

- **Delivery is at least once.** Webhooks retry, pollers re-read after a crash. Make handlers idempotent on `update_id` and side effects safe to repeat. → `updates-and-delivery.md`
- **One consumer per token**, and a webhook that verifies its secret header and answers fast, doing the work afterwards. → `updates-and-delivery.md`
- **Subscribe to what you handle.** `allowed_updates` excludes some update types by default and keeps the previous setting when omitted. → `updates-and-delivery.md`
- **Answer every callback query and every message**, even on errors — users see a spinner or silence, and BotFather's status alerts watch reply rates. → `ux-and-messaging.md`
- **Buttons over typed commands; edit the screen in place; confirm destructive actions.** → `ux-and-messaging.md`
- **Everything a user, a page or another bot sends is untrusted input** — callback data, deep-link payloads, Mini App data, message text (and, for LLM bots, a prompt-injection vector). Validate Mini App `initData` on the server. → `security-and-privacy.md`, `mini-apps.md`
- **The token is the bot.** Server-side only; never in logs, client code or file URLs you hand out. → `security-and-privacy.md`
- **429 means wait exactly `retry_after`.** Broadcasts are paced, resumable jobs. → `limits-and-performance.md`
- **Digital goods are sold in Telegram Stars; deliver on `successful_payment`, never on pre-checkout; support `/paysupport`.** → `payments-stars.md`
- **Follow the developer terms**: privacy policy, minimal data, deletion on request, no collecting Telegram data for AI training. → `security-and-privacy.md`
- **Text you did not write must be escaped for the parse mode, or sent without one.** → `ux-and-messaging.md`

## Which reference to open

| The task involves | Open |
|---|---|
| any method call, an "it doesn't exist / doesn't work" report, choosing between approaches, library lagging behind | `references/freshness.md` |
| polling or webhooks, deploys, scaling, shutdown, duplicates or lost updates | `references/updates-and-delivery.md` |
| `/start`, menus, keyboards, callbacks, commands, formatting, long text, deep links, groups and topics | `references/ux-and-messaging.md` |
| token, webhook secret, sign-in, permissions, user data, privacy policy, abuse | `references/security-and-privacy.md` |
| broadcasts, bursts, 429s, files, throughput | `references/limits-and-performance.md` |
| error handling, retries, flaky behavior, odd updates | `references/errors-and-edge-cases.md` |
| "what can a bot do", choosing product options, BotFather settings | `references/product-features.md` |
| selling, subscriptions, refunds, payment disputes | `references/payments-stars.md` |
| a Mini App: launch, auth, theme, buttons, storage | `references/mini-apps.md` |
| an LLM/agent bot: streaming, model output formatting, threads, bot-to-bot, guest mode | `references/ai-bots.md` |
| a review or audit before release | `references/review-checklist.md` |

Open only what the task needs; several tasks need two (for example a paid Mini App: `mini-apps.md` and `payments-stars.md`).

## How to present the work

- Write code in the project's own library and style, with the method names the library uses (camelCase in JS, snake_case in Python…), but parameters exactly as the current docs define them.
- When you use something introduced recently or replaced recently, say so in a short comment or in the answer, with the docs page — the next reader's memory is stale too.
- List the BotFather settings the owner must change by hand (privacy mode, inline mode, menu button, Mini App settings, guest or management mode, payments, paid broadcasts) — code cannot change them.
- For product questions, give each option with what it gives, what it costs and what it locks in, and recommend one.
- Build what was asked. The extras these references recommend (a Stop button, topics, splitting long answers, extra handlers) go into the answer as options with their cost, unless the task asks for them — each one is code the owner has to keep.
