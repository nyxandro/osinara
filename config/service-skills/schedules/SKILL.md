---
name: schedules
description: Load before creating, changing, pausing, resuming, running now or deleting a reminder, a scenario or a wake-up in this chat (manage_reminder, manage_agent_schedule), and before answering a tap under a reminder that asks to postpone it. It holds the reminder text rules, the scenario parameters and the wake-up and monitor rules.
---

# Reminders, scenarios and wake-ups

Call the first two exactly "напоминание" and "сценарий" to the person. An explicit request is enough for any of these actions: do it without additional confirmation and report success only after the tool result. Ask only for what is missing or ambiguous; do not ask again for data already known from the request and the settings.

## Reminders

A reminder is ready-made text that the bot itself sends at the set time or on a repeat, without calling the model: do not store a task to compose or do something later in its place. If asked to come up with a message to send on a timer, prepare it now. The text is laid out like your answers, formatting and files shown as `![caption](/workspace/...)` included. Searching memory is not a way to find or manage reminders.

The text is read at the moment of delivery, not now, so write it as if you were speaking at that minute. Do not carry over words from the request that count from the moment of setting it: "завтра", "послезавтра", "через неделю", "в эту пятницу". Name the event time by the clock, not "через 10 минут": if quiet hours delay delivery, such a countdown becomes false. If the event is on the day of delivery, write "в 17:00" or "сегодня в 17:00"; if on another day, the weekday and date: "в пятницу, 10 октября, в 17:00". If the reminder arrives exactly when the thing is due, the time need not be repeated. Do not write calendar dates in a recurring reminder.

Example: on October 7 at 23:12 someone asks "напомни завтра в 9:30 сдать отчёт". Bad content: "Завтра в 9:30 сдать отчёт". Good content: "Пора сдать отчёт".

Where they live:
- In a private chat reminders are personal. Before the first personal reminder get `notification_settings`; if there are none, ask for the IANA timezone and quiet hours and save them through that tool.
- In a family group reminders belong to this group or its current topic. Use the timezone the person has already configured; if there is none, ask them to set up the timezone and quiet hours in a private chat with you first.

Always pass the time and the timezone together: `manage_reminder` with action `create` needs an exact time with a UTC offset, an IANA timezone and either no recurrence or a recurrence period. Do not guess the time, the timezone, the scope or the recurrence, and do not infer the timezone from geolocation or language. Before an ambiguous change or deletion, get the current state through `list_reminders`. A one-time reminder that has already arrived is not in that list and cannot be changed: if asked to move or repeat it, create a new one.

A reminder may carry reply buttons: write the button markup of your instructions at the end of `content` when the reminder implies an action to report or postpone, for example «✅ Оплатил» and «⏰ Через час» for paying the internet bill. The buttons follow the content: a reminder whose new `content` has no markup loses them. A tap under a reminder comes to you as the person's message: for a postponement set a new one-time reminder with the same content, buttons included, for the moment the button names, counted from the tap, and say for what time; for a done action answer briefly.

## Scenarios

A scenario is your own run on a schedule with a specific task: a morning summary, a news digest, a list of urgent emails, a portfolio report. Set it up only through `list_agent_schedules` and `manage_agent_schedule` with `"executionContext":"isolated"`, never through `manage_reminder`. In a private chat scenarios are personal; in a family group they belong to this group or its current topic.

Creating one requires the exact first run time with a UTC offset, an IANA timezone, the recurrence (`once`, `minutely`, `hourly`, `daily`, `monthly`, `yearly` or `weekly` with ISO weekdays 1-7), where to send the result and a clear scenario with criteria for a finished result. Do not guess the timezone, frequency, news topic, mail filter, brokerage mode or list of sources.

Phrase `scenarioPrompt` as a stable instruction for a future autonomous run: what to collect, which sources or integrations to use, which constraints to observe, what format of the final message to send and when not to send an empty report. Do not include secrets and do not write one-off data into it. Before an ambiguous change, pause, resume, manual run or deletion, get the current state through `list_agent_schedules`. Never replace a scenario with an ordinary reminder without the person's direct consent.

## Recurrence

Reminders and scenarios support intervals from one minute. Minutes and hours are elapsed duration; days, weeks, months and years are calendar recurrence in the chosen timezone. For February 29 in a non-leap year February 28 is used, and in a leap year the 29th again; for the 31st, a short month uses its last day without shifting the original date. The backend checks the time once a minute without calling the model. Missed periods are not caught up, and a new run of the same scenario waits for the current one to finish.

## Wake-ups

A wake-up is a scenario with `"executionContext":"conversation"`: at the set time you continue the current task in this same conversation, with the whole chat history, files and tool results. Use it whenever a task has to wait for an external event and be checked later: a delivery, a website coming back, a long build, an answer that should arrive. Do not wait inside a turn, for example with `sleep` in the sandbox: while the turn is open, the chat does not answer. An independent regular report like a digest is `"isolated"`. Ready-made text for a deadline is a reminder.

For a wake-up `maxRuns` is required, no more than 50: choose the smallest number of runs that covers a reasonable wait, for example 12 times every 10 minutes for two hours. No more than three active wake-ups in one chat. In `scenarioPrompt` write a self-contained note: what to check, how to tell the goal is reached, what to tell the person. In `userRequest`, the person's task you are waiting for. Having set a wake-up, briefly tell the person when you will check.

When the awaited event can be recognized by a short script, without reading and judging, make the wake-up a monitor: add `checkCommand` and `checkUntil`. Every period the scheduler runs the check in this chat's sandbox without you and wakes you only when it prints something, while a plain wake-up is a full turn every time; keep a plain wake-up when checking needs judgment. The check is Bash: print nothing while nothing has happened, print a short report when the event happens, exit non-zero only on a real failure. It only reads and keeps no state: it must not send, buy, write files or change anything, and it may run twice for the same moment. Use curl, jq, grep or python, never the browser. To report a change rather than a state that stays true, put the last seen value into the check itself; when it wakes you, update `checkCommand` with the new value or pause the monitor, otherwise every check after the event wakes you again. Run it yourself exactly once before creating the monitor: if it prints nothing and exits with 0, create the monitor right away and do not test it further, because the tool runs it once more and refuses a broken check or one whose event has already happened, which you then report right away. A monitor checks at most every 5 minutes; `checkUntil` is the end of the watch, at most 14 days ahead, and at it you are woken one last time to tell the person how it went. `maxRuns` counts only your wake-ups, not the checks, and the watch also ends with the wake-up that uses it up. After three broken checks in a row you are woken to fix it; a wake-up may change its own monitor's check, window and note.

The state `paused_conversation_changed` in `<planned_wakeups>` means the wake-up is left over from a previous conversation, and `paused_not_started` means it did not start because of a failure: offer to delete it or resume it here.

Example: "скажи, когда привезут посылку" with a tracking link, and the page says it is on its way. Bad: answer "буду следить" with nothing set, or create a daily isolated scenario. Good: a monitor whose `checkCommand` prints a line once the tracking page shows the delivery, `checkUntil` a few days ahead, and one sentence telling the person you will write when it arrives.
