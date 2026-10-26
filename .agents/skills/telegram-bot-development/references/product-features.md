# What a bot can do: a map to the current features

**Load this when** the user asks what is possible, chooses between product options, plans a feature, or you are about to say "Telegram does not support that". This file is a map, not the list: Telegram adds capabilities every few weeks, so start from the live table of contents.

```bash
python3 scripts/tgdocs.py page bots/features --toc          # every capability Telegram documents today
python3 scripts/tgdocs.py page bots/features --section "<heading>"
python3 scripts/tgdocs.py changes --since <version you know>  # what arrived recently
python3 scripts/tgdocs.py search <word>                      # methods and types for it
```

When you recommend an option, say what it gives the user, what it costs (setup, money, permissions, user friction), and what it locks in — and confirm it in the docs first.

## Areas and the questions they answer

| Area (features page section) | Use it when | Notes and trade-offs to check |
|---|---|---|
| **Commands, command scopes, menu button, global commands** | users need shortcuts and discovery | keep few commands; scopes per audience and language; the menu button can open a Mini App instead |
| **Keyboards, inline keyboards** | any interactive flow | inline for in-message actions, reply keyboard for a simple persistent menu and for requesting contact/location/chats (see `ux-and-messaging.md`) |
| **Chat and user selection** | the user must pick a user, group or channel for the bot | the picker returns ids with the user's consent instead of asking them to type usernames |
| **Inline requests (inline mode)** | users should pull the bot's content into any chat | enabled in BotFather; the bot answers queries, the *user* sends the result |
| **Deep linking, attachment menu** | onboarding sources, referrals, account linking, opening the bot in context | payload alphabet and length are restricted |
| **Ephemeral messages** | something in a group only one person should see | a recent feature; parameters changed between releases — check `history ephemeral` |
| **Streaming replies** | generated answers (AI, search) should appear progressively | private chats; temporary drafts plus a final message; optional Stop button; open to all bots since 9.5, topics not required — but the developer terms still tie it to topics (`ai-bots.md`) |
| **Topics in private chats** | separate threads with one user (AI chats, tickets) | while enabled, every Stars purchase in the bot carries a non-refundable fee (developer terms 6.2.6; the figure: `payments-stars.md`) — an owner decision in any bot that sells |
| **AI agents, bot-to-bot communication, guest bots** | AI assistants, multi-agent flows, a bot summoned into chats it is not a member of | bot-to-bot requires loop prevention; guest mode gets one reply per mention and no history (`ai-bots.md`) |
| **Polls, quizzes, checklists, live photos, stickers, custom emoji** | richer content | each has its own send method and limits |
| **Messages and formatting, rich messages** | structured answers: tables, blocks, buttons inside content | rich messages have their own methods and limits (`page bots/api/rich-messages`) |
| **Communities, channel direct messages, suggested posts** | bots around channels and linked chats | newer areas — read the section before designing |
| **Monetization: Telegram Stars, digital products, paid media, subscriptions, ad revenue sharing** | charging for anything digital | digital goods only in Stars; obligations in the developer terms (`payments-stars.md`) |
| **Payments (physical goods)** | selling physical goods and services | third-party payment providers, not Stars (`tgdocs.py page bots/payments`) |
| **Mini Apps** | a UI richer than messages | sign-in validation, theming, full screen, home screen shortcuts, device APIs (`mini-apps.md`) |
| **Business bots** | acting in a user's business chats | strict rules on using those messages in the developer terms |
| **Managed bots** | letting users create and run their own bots through yours | enabled in BotFather; your bot receives updates about the bots it manages |
| **Web login (widgets, inline login)** | signing users in on a website with Telegram | verify the login data server-side |
| **Language support** | multilingual bots | per-language commands and descriptions |
| **Serverless** (`page bots/serverless`) | hosting the bot and Mini App backend on Telegram itself | its own project/module model, database and CLI — a platform choice with lock-in |
| **Testing: test environment, status alerts, local Bot API** | development and operations | the test environment relaxes some rules (e.g. HTTP links for Mini Apps) but not flood limits; BotFather sends status alerts when a popular bot answers too few messages, inline queries or callback queries |

## BotFather settings that change behavior

Several capabilities are switched on per bot in @BotFather (its chat or its Mini App), not through the API: privacy mode, inline mode, the menu button, Mini App settings (including the Mini App domain protection), guest mode, bot management mode, paid broadcasts, payments, business mode, games. When a feature "does nothing", check whether it is enabled there, and say in your answer which setting the owner must change — the bot code cannot do it.

## Privacy mode in one paragraph

By default a bot in a group sees only messages meant for it (its commands, replies to it, service messages) — unless it is a group admin or privacy mode is off (which needs the bot re-added). Telegram recommends keeping it on unless the product truly needs every message (`page bots/features --section "Privacy Mode"`). Turning it off is a product and trust decision: users see the setting in the member list.
