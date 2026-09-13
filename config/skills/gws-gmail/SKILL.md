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

Change one message only with the structured `manage_gmail_message` tool. Copy both `messageId` and
`profileRef` unchanged from a previous Gmail result:

```json
{"action":"trash","messageId":"MESSAGE_ID","profileRef":"PROFILE_REF"}
{"action":"delete","messageId":"MESSAGE_ID","profileRef":"PROFILE_REF"}
{"action":"restore","messageId":"MESSAGE_ID","profileRef":"PROFILE_REF"}
{"action":"mark_read","messageId":"MESSAGE_ID","profileRef":"PROFILE_REF"}
{"action":"mark_unread","messageId":"MESSAGE_ID","profileRef":"PROFILE_REF"}
```

Do not pass message or thread `trash`, `delete`, `untrash`, `modify`, `batchDelete`, or `batchModify`
through `execute_google_workspace`. Before Eve asks
for approval, Osinara loads the exact message from the current verified Google profile and displays
its mailbox, sender, subject, date, short snippet, and immutable Gmail ID. `trash` is recoverable;
`delete` permanently deletes the message. For multiple messages or a thread, resolve its message IDs
first, then call `manage_gmail_message` separately for each one. A command-forbidden result does not
prove that the Google profile is read-only or lacks an OAuth scope; follow its correction and use the
structured tool when directed.
