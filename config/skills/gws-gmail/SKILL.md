---
name: gws-gmail
description: "Gmail: Send, read, and manage email."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws gmail --help"
---

# gmail (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

```bash
gws gmail <resource> <method> [flags]
```

## Helper Commands

| Command | Description |
|---------|-------------|
| [`+send`](../gws-gmail-send/SKILL.md) | Send an email |
| [`+triage`](../gws-gmail-triage/SKILL.md) | Show unread inbox summary (sender, subject, date) |
| [`+reply`](../gws-gmail-reply/SKILL.md) | Reply to a message (handles threading automatically) |
| [`+reply-all`](../gws-gmail-reply-all/SKILL.md) | Reply-all to a message (handles threading automatically) |
| [`+forward`](../gws-gmail-forward/SKILL.md) | Forward a message to new recipients |
| [`+read`](../gws-gmail-read/SKILL.md) | Read a message and extract its body or headers |
| [`+watch`](../gws-gmail-watch/SKILL.md) | Pull one bounded batch of new emails |

## API Resources

### users

  - `getProfile` - Gets the current user's Gmail profile.
  - `stop` - Stop receiving push notifications for the given user mailbox.
  - `watch` - Set up or update a push notification watch on the given user mailbox.
  - `drafts` - Operations on the 'drafts' resource
  - `history` - Operations on the 'history' resource
  - `labels` - Operations on the 'labels' resource
  - `messages` - Operations on the 'messages' resource
  - `settings` - Operations on the 'settings' resource
  - `threads` - Operations on the 'threads' resource

## Discovering Commands

Before calling any API method, inspect it:

Call `execute_google_workspace`. For the unread message list, inspect the schema and then supply its required parameters:

```json
{"argv":["gmail","--help"]}
{"argv":["schema","gmail.users.messages.list"]}
{"argv":["gmail","users","messages","list","--params","{\"userId\":\"me\",\"q\":\"is:unread\",\"maxResults\":20}"]}
```

Use `gws schema` output to build your `--params` and `--json` flags.

## Message mutations through Osinara

Pass each API resource and method as a separate `argv` entry. Do not combine resource and
method segments such as `users.messages.trash`, and do not put `schema` after `gmail`.
Schema discovery for API reads is a top-level command.

Change message state only with the structured `manage_gmail_message` tool. Put every selected
message into one call, up to 30 `messageIds`, and copy `profileRef` unchanged from a previous Gmail
result. Never call the tool once per message:

```json
{"action":"trash","messageIds":["MESSAGE_ID_1","MESSAGE_ID_2"],"profileRef":"PROFILE_REF"}
{"action":"delete","messageIds":["MESSAGE_ID"],"profileRef":"PROFILE_REF"}
{"action":"restore","messageIds":["MESSAGE_ID_1","MESSAGE_ID_2"],"profileRef":"PROFILE_REF"}
{"action":"mark_read","messageIds":["MESSAGE_ID_1","MESSAGE_ID_2"],"profileRef":"PROFILE_REF"}
{"action":"mark_unread","messageIds":["MESSAGE_ID"],"profileRef":"PROFILE_REF"}
```

To collect a batch, search once with `+triage` and an explicit query; its result lists `id`, `from`,
`subject` and `date` of every match. Without `--query`, `+triage` returns unread mail only:

```json
{"argv":["gmail","+triage","--max","30","--query","from:news@example.com older_than:30d"]}
```

A request to delete messages without the word "permanently" means `trash`; use `delete` only when
the user explicitly asks to delete forever. When more than 30 messages match, change the first 30,
then ask whether to continue with the next batch. When the user asks to see messages first, list
their subjects grouped by sender, with the number of messages from each sender.

Do not pass message or thread `trash`, `delete`, `untrash`, `modify`, `batchDelete`, or `batchModify`
through `execute_google_workspace`. Before Eve asks for approval, Osinara loads every message of the
batch from the current verified Google profile and shows one card: the mailbox, then senders and
subjects grouped by sender address. A single message also shows its date, short snippet and
immutable Gmail ID. Do not repeat that list in chat before the call unless the user asked to see it
first. `trash` is recoverable; `delete` permanently deletes the messages. For a thread, resolve its
message IDs first and pass them as one batch. A command-forbidden result does not prove that the
Google profile is read-only or lacks an OAuth scope; follow its correction and use the structured
tool when directed.
