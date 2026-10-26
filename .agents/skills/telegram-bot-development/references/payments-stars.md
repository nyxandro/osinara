# Taking money: Telegram Stars and physical payments

**Load this when** the bot or its Mini App sells anything, offers subscriptions, refunds, paid media, or a user reports a payment problem. Money code is where stale knowledge costs most: read `tgdocs.py page bots/payments-stars` (digital), `page bots/payments` (physical), the method pages for every call you make, and section 6 of the developer terms (`tgdocs.py terms --section 6`) before writing it.

## Which rail

- **Digital goods and services** (access, content, features, credits, subscriptions to digital things) are sold **only in Telegram Stars**, currency `XTR`. No card provider, no crypto, no "pay on our website" workaround for digital goods inside Telegram — check the guide's FAQ for the current wording.
- **Physical goods and services** use third-party payment providers connected in @BotFather (`page bots/payments`). Telegram does not process those payments.

## The Stars flow

1. Create an invoice: `sendInvoice` in a chat, or `createInvoiceLink` for a link (also used by Mini Apps). Currency `XTR`; check the method page for the provider-token rule and every other parameter.
2. Telegram sends a `pre_checkout_query`. Answer with `answerPreCheckoutQuery` **within the time limit stated on its method page (seconds, not minutes)**: validate against your own state (item exists, price unchanged, user allowed) and nothing slow. A missed answer cancels the payment.
3. Telegram sends a message with `successful_payment`. **Deliver only here** — answering the pre-checkout query does not mean the user paid.
4. Store `telegram_payment_charge_id` with what you granted; a refund needs it.

## Make it safe

- **Idempotency:** the `successful_payment` update can be delivered more than once (`updates-and-delivery.md`); key the grant on the charge id with a unique constraint, so one charge grants once.
- **Your ledger:** record purchases and grants in your own database. Telegram's transaction list (`search StarTransaction`) is for reconciliation, not your source of truth for entitlements.
- **Refunds:** `refundStarPayment` returns the Stars; revoke what was granted, keyed on the same charge id. Refund losses come out of the bot's balance.
- **Subscriptions** (periodic Stars charges via invoice links) and **paid media** have their own fields and updates — read their method and type pages, and handle renewal, cancellation and expiry as state changes in your ledger.
- **Never deliver on the client's word.** A Mini App saying "paid" is not a payment; only the bot's `successful_payment` update (or the transaction list) is.
- **Do not log payment payloads or charge ids alongside personal data** more than you need.

## Obligations (developer terms and the guide — re-read before going live)

- The bot (or Mini App) must respond to `/paysupport` and handle payment disputes; the guide also asks for an easy way to reach your terms (for example a `/terms` command).
- You are responsible for disputes and for delivering what was paid for; if you cannot deliver, refund.
- Stars received are subject to the terms in section 6.2 (holding periods, validity, how they can be used or converted) — check the current text instead of quoting numbers from memory.
- Private-chat topics change the economics: while they are enabled — and for a processing delay after they are switched off — Telegram withholds a non-refundable fee from every Stars purchase in the bot: 15% when checked in October 2026, and Telegram reserves the right to change it — quote the current figure from `tgdocs.py terms --section 6.2.6`. Check whether the bot has them on before quoting revenue, and make enabling them the owner's decision: the changelog opened streaming drafts to all bots in Bot API 9.5, although the terms still tie streaming to topics (`ai-bots.md`).
- Taxes are yours.

## Testing

Stars payments can be tested in Telegram's dedicated test environment (`page bots/features --section "Testing your bot"`), with a separate test bot. Test the unhappy paths: pre-checkout rejected, payment succeeded but your delivery failed (refund), duplicate `successful_payment`, refund after grant.
