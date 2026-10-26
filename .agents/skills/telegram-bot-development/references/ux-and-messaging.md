# Conversation design, keyboards, commands, formatting

**Load this when** designing what the bot shows and how a user moves through it: `/start`, menus, buttons, settings, confirmations, long answers, formatting, deep links, groups. The principles are stable; check method parameters with `tgdocs.py method <name>` and look for newer presentation features with `tgdocs.py page bots/features --toc` (rich messages, ephemeral messages, button styles and disabled buttons have all appeared recently).

## The rule underneath

People tap buttons far more readily than they type commands. Commands are for discovery and shortcuts; navigation belongs to buttons. If a step can be a button, make it one; if a screen can be updated in place, update it; if a user can reach a dead end, give them a way back.

## `/start` is the homepage

- Telegram asks every bot to support `/start`, `/help` and, where it applies, `/settings`; clients show shortcuts for them (`page bots/features --section "Global Commands"`).
- `/start` should say in one line what the bot does, in two or three lines what the user gets, and offer the primary actions as buttons. No wall of text, no "Welcome!" line on its own, no list of every feature.
- `/start` can carry a deep-link parameter (below) — handle it, and handle its absence.
- Register commands with `setMyCommands` so the client's menu shows them. Keep the list short and make every listed command reachable by buttons too. Use `scope` for different audiences (for example, admin-only commands for chat administrators) and `language_code` for translations.

## Inline vs reply keyboards

| | Inline keyboard | Reply keyboard |
|---|---|---|
| Attached to | one message | the input area |
| A press | a `callback_query` to the bot | the label sent as a normal message |
| Use for | menus, actions, toggles, pagination, anything editable | a small persistent main menu in simple bots; requesting a contact, location, chat or users |

- **Answer every callback query.** The client shows a progress indicator until the bot calls `answerCallbackQuery`, even when there is nothing to say — call it on every path, including errors. Empty answer for navigation, a short notification for "Saved", `show_alert` only for something the user must acknowledge.
- `callback_data` is small (check the byte limit in `type InlineKeyboardButton`). Put an action and an id there, keep the state in your store. It is user-controlled input: a modified client can send any value, so re-check permissions and ownership on every press.
- A user can press the same button twice before your first answer arrives. Make actions idempotent (or check state) so a double tap does not double the effect.
- Labels are the interface: a verb or a destination, the same word everywhere for the same thing. For toggles, the label shows the current state ("✅ Notifications"). Do not mix toggles and navigation in one row.

## Update the screen, send events

- Navigation inside the bot edits one message (`editMessageText`, `editMessageReplyMarkup`, …) so the chat stays clean and "where am I" is always at the bottom.
- New messages are for events the user wants to keep: results, receipts, notifications, errors.
- Editing to identical content fails with an error; skip the edit when nothing changed instead of catching it blindly.
- Messages can be deleted only within a time window and only by permission (`method deleteMessage` lists both); design flows that do not depend on cleaning up old messages.

## Menus, confirmations, empty and slow states

- Deeper than one level: say where the user is, give "Back" one level up and "Home" when it is deeper than two.
- Destructive actions (delete data, leave, pay) always go through a confirmation screen that restates the consequence, with the safe option first.
- Empty lists are an invitation, not a blank: explain what will appear and offer the action that creates the first item.
- Anything slower than a moment needs immediate feedback: `sendChatAction` ("typing", "upload_photo"…) lasts only a few seconds, so repeat it for longer work; for progress, edit a placeholder message at a coarse pace.
- For answers generated over many seconds (an LLM, a search), use the native draft/streaming methods where available — see `ai-bots.md` — rather than editing a message in a loop.

## Formatting and length

- Text and captions have hard limits measured **after entity parsing** (`method sendMessage`, `method sendPhoto`). Split long output yourself on paragraph or line boundaries, never mid-entity, and never let a report fail with a 400 on the one message that mattered.
- Parse modes (MarkdownV2, HTML, legacy Markdown) and entities are described in `page bots/api/formatting`. MarkdownV2 requires escaping a set of characters everywhere outside entities; an unescaped character from user or model text breaks the whole message. When the text is not yours (user input, model output), either escape it for the chosen mode, send entities explicitly, or send plain text.
- Rich messages (structured blocks, tables, buttons inside the content) are a separate send surface with their own methods and limits: `page bots/api/rich-messages`, `search rich`.

## Deep links

- `https://t.me/<bot>?start=<payload>` opens the bot and delivers `/start <payload>`; `?startgroup=<payload>` asks the user to add the bot to a group; Mini Apps have their own `startapp` links. The payload alphabet and length are restricted (letters, digits, `_`, `-`, a few dozen characters — check `page bots/features --section "Deep Linking"`); base64url-encode anything else.
- Use them for referral codes, onboarding sources, and linking a Telegram user to an account elsewhere. A payload is visible and replayable: for account linking use a short-lived, single-use token, never an id or a secret.

## Groups, channels, topics

- Privacy mode is on by default: in groups a bot sees commands addressed to it, replies to its messages and service messages — not ordinary chatter — unless it is an admin or privacy mode is turned off (and it was re-added). Design around it; ask for privacy mode off only when the product truly needs every message.
- Reply in the thread or topic you were addressed in (`message_thread_id`); in groups keep answers short and prefer private chat for long flows (a deep link to the bot).
- For something only one person in a group should see, there are ephemeral messages (`search ephemeral`) — check current support before falling back to a private message.
- Anonymous admins and channels post as a chat (`sender_chat`), not a user; permission checks must handle that.
- When a group becomes a supergroup, its id changes: the error carries `migrate_to_chat_id` — update stored ids.

## Language and tone

- Use the user's language (`language_code` on the user is a hint, not a guarantee); let them change it.
- Errors in plain words with what to do next; never a stack trace, never a raw API error text.
- Do not imitate Telegram's own interface or system alerts, and keep every element closable — this is also in the developer terms.
