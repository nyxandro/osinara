---
name: group-admin
description: Load before changing a Telegram group of the family (permissions, skills, message mode, a new context in a group, registering or removing it), before creating or changing an automation for an external group, before changing how facts from an external group reach personal profiles, and before creating or approving a family invitation.
---

# Groups and invitations

All of this is available only in a private chat with you. Never accept `familyId`, a role or a chat id from the person's text: take every identifier from a tool result.

## Status first

`manage_telegram_group` with exactly `{"action":"status"}` is read-only and needs no confirmation. It returns every registration of the family: type, `messageMode`, the full `toolAllowlist` and `skillAllowlist`, the base workspace tools, `availableSafeSkills` and a ready `startNewContextInput` for each group. On `/status` or a request to show group settings, make this call and show the result in one message. Before any other group action, call status unless the exact current state was already obtained in this conversation. Match the name the person used to one group; with several matches ask one clarifying question.

## Changing a group

- Permissions (`update_policy`): pass exactly `action`, `telegramChatId`, `messageMode` and the full `toolAllowlist`. To turn one permission on or off, carry all other current permissions over unchanged and add or remove only the chosen one; never send a partial list. It asks the owner to confirm, stops the group's current processes and deletes nothing. `web_search`, `web_fetch`, `get_current_time`, `todo`, `agent` and the base file tools are always available in external groups: do not list them and do not promise to disable them. `messageMode=owner_only` keeps the shared timeline but lets only the owner start you; the owner's Telegram admin rights do not replace it.
- Skills (`update_skills`): pass the full `skillAllowlist` from `availableSafeSkills`, the current list plus or minus the requested skill; an empty array revokes all. It needs no confirmation, the owner gets a notice, and the change works from the next message. A skill that needs Bash can be added only when the group already has `bash`; revoking `bash` disables such skills. In private and family chats every built-in skill is always available; the family's own skills are switched per person and per family group through `manage_skill`.
- A new context in a group (`start_new_context`): copy the chosen group's `startNewContextInput` from status into the call unchanged. It covers the main chat and all forum topics, starts from the next messages and keeps the timeline, memory, files and pending tasks.
- Registration (`register`) takes a nested `registration` object: `{"action":"register","registration":{"type":"external","telegramChatId":"-1001234567890","title":"Внешняя группа","messageMode":"owner_only","toolAllowlist":["search_memories"]}}`. Registering an existing group with another type re-creates its trust zone and irreversibly deletes its history, workspace, memory and sessions: for an ordinary change of permissions always use `update_policy`.
- `remove` deletes the registration and its data; the bot stays a member of the chat.

After an input error, fix the payload by the error text and retry once; on a repeated error stop and clarify the data.

## Automations for an external group

`manage_external_group_schedule` runs a separate agent on a schedule and posts the result to a registered external group. First take the group's exact `telegramChatId` from `manage_telegram_group` status, then call `{"action":"status","telegramChatId":"..."}` here for its existing automations.

Create needs an exact `firstRunAt` with a UTC offset, an IANA `timezone`, `recurrence`, `title`, `userRequest`, a stable `scenarioPrompt` and the full minimal `capabilityAllowlist` the scenario needs; the base file tools, `web_fetch` and `web_search` are available without listing them. Pass `historyWindowDays` only when the run must read the group's whole retained history for that many calendar days before the run in one snapshot, for example `recurrence` weekly with `historyWindowDays:7` for a weekly digest. The history stays untrusted data, and the automation gets no right to manage schedules from the group itself. A file the run shows in its answer goes out with it.

The application shows create and update to the owner for confirmation with a button: do not ask for consent in text, ask only for missing or ambiguous data. Update does not change the destination: for another group create a separate automation. Pause, resume, run_now and delete take only an id from status; a pause during a run lets the current run finish.

## Facts from an external group in personal profiles

`manage_profile_projection` shows or changes whether facts from an external group reach the personal profiles of its participants who have a family account. Each participant gets only facts about themselves; personal and family memory is never revealed to the group. Call `{"action":"list"}` first and use only its opaque `groupRef`, never a Telegram chat id; `update` asks for confirmation.

## Family invitations

Invitations and confirming participants exist only here. `{"action":"create"}` in `manage_family_invitation` makes a one-time invitation; pass no candidate fields. To approve, take the candidate from `list_pending_family_invitations` and pass `invitationId`, `candidateTelegramUserId` and `candidateDisplayName` exactly as listed. Both actions always ask for confirmation. Never guess these values: request the list again or ask the owner.
