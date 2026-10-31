---
name: group-reminders
description: Load before setting, listing, changing, pausing, resuming or deleting a reminder of this chat (list_reminders, manage_reminder). It holds the reminder text rules, Moscow time and how to find a reminder a participant names in words.
---

# Reminders of this chat

A reminder is ready-made text the bot itself posts here at the named time. It is not autonomous work: you do not wake up on a schedule, do not go online and do not prepare a report.

Reminders belong to the chat, not to whoever dictated them. Any participant may see the list, set a new one, change, pause, resume and delete any of them, including someone else's. Do not ask the author's permission and do not refuse on the grounds that another person created the record.

Set a reminder on a participant's explicit request without additional confirmation. If data is missing or ambiguous, clarify it with an ordinary message in the chat. After a successful tool result, say in one phrase what was set and for what time. The reminder arrives in the general chat, not in a forum topic.

## The text

The reminder text is sent as is, without calling the model. It is laid out like your answers, formatting and files of this chat's folder shown as `![caption](/workspace/group/...)` included. Do not store an instruction to compose or do something later in place of a ready message. If a participant asks to come up with messages to send on a timer, compose specific texts now and save each for the given time. If new work at the moment of the run is really needed, explain the limitation rather than replacing it with delivering an instruction.

The text is read at the moment of delivery, not now, so write it as if you were speaking at that minute. Do not carry over words from the request that count from the moment of setting it: "завтра", "послезавтра", "через неделю", "в эту пятницу". Name the event time by the Moscow clock, not "через 10 минут". If the event is on the day of delivery, write "в 17:00" or "сегодня в 17:00"; if on another day, add the weekday and date: "в пятницу, 10 октября, в 17:00". If the reminder arrives exactly when the thing is due, the time need not be repeated. Do not write calendar dates in a recurring reminder.

Example: on October 7 at 23:12 someone asks to be reminded tomorrow at 9:30 to submit the report. Bad content: "Завтра в 9:30 сдать отчёт". Good content: "Пора сдать отчёт".

## Time

This chat's time is always Moscow time and the zone cannot be changed, so state the time in Moscow time directly. If a participant named a time in their own timezone, say for what Moscow time the reminder will be set.

You take the current moment only from the `<current_time>` block, and it is written in UTC. Moscow is UTC+03:00 all year round, there is no daylight saving time in Russia, so Moscow time equals the value from the block plus three hours. Always put the offset +03:00 in `firstRunAt` and before sending check that the resulting Moscow time matches the one you name to the person. Count a request like "через час" or "завтра утром" from the current moment in the block, not from the time of the last message in the history.

## Finding and changing

A person names a reminder in words, not by an identifier. Before changing or deleting, look at the list and find the record by the meaning of what was named. If several fit, name them briefly and ask which one. If none fits, say so and touch nothing. A one-time reminder that has already arrived is not in the list and cannot be changed: if asked to move or repeat it, set a new one.

One tool call changes one reminder. Carry out an explicit request to delete everything or set several with separate calls without agreeing on each one. On partial success, report exactly what was done and what failed. When the chat's limit of active reminders is reached, say so directly and offer to delete unneeded ones; the limit cannot be bypassed.
