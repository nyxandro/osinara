---
name: widgets
description: Load before calling send_widget or update_widget. It has the A2UI catalog of Telegram widgets, how to describe a widget, how presses and updates reach you, and when and how to write your own HTML widget.
---

# Telegram widgets

A widget is a small interactive card Telegram draws inside the message, in the person's own theme. You describe it with the A2UI 1.0 protocol: a flat list of components from the catalog below and a data model. The application checks the description, builds the widget and sends it; you never write its HTML. Only for a game or an animation the catalog cannot describe do you write your own HTML (the last section).

## The message

`send_widget` takes `caption` and `surface`. `surface` is exactly one A2UI message:

```json
{"version":"1.0","createSurface":{"surfaceId":"menu_2026_11_09","catalogId":"urn:osinara:a2ui:telegram-widget:1","components":[...],"dataModel":{...}}}
```

- `surfaceId`: letters, digits, `_` or `-`, new for every widget in the chat (a topic and a date work well). You use it to update the widget later.
- `components`: a flat list; each has `id`, `component` and its properties. The widget starts at the component with `id` `"root"`. Every other component is the child of exactly one parent and reachable from root. A list template may be shared by several lists.
- `dataModel`: the data the components read. Keep data in it and bind to it when the values may change later or come from a list.
- No `theme`: colours come from Telegram.

## Values and data

- A value is a literal, a binding `{"@path": "/going"}` (a JSON Pointer into the data model) or a function `{"@call": "formatString", "args": {"value": "Идут ${/going} из ${/total}"}}`.
- A container's `children` is a list of ids, or a template `{"componentId": "slot", "path": "/mon"}`: the template renders once per item of the list, and inside it a path without the leading `/` reads the item (`{"@path": "time"}`). At most 50 items.
- `formatString` takes `${/absolute}` and `${relative}` paths only; call other functions as separate values.
- Dates and moments: an ISO date (`2026-11-07`) or a moment with its offset (`2026-11-07T17:30:00+03:00`), in the person's time zone as you know it. A moment without an offset is refused: never guess a zone.
- Numbers, amounts and dates come out in Russian (`12 345,5`, `1 500 ₽`, `вторник, 10 ноября`).

## The catalog

<!-- catalog:start (generated from agent/lib/widgets/a2ui/catalog.ts) -->
catalogId: `urn:osinara:a2ui:telegram-widget:1`. Every component may also take `weight` (1-10, its share of a Row or Column). * marks a required property.

Components:
- **Text** — Text. Supports **bold**, *italic* and line breaks; no links or HTML. `text`* — The text; `variant` — title, subtitle, body (default) or caption (small, muted).
- **Icon** — A small icon from the list of icon names. `name`* — Icon name from the icon list.
- **Row** — Children side by side; wraps to the next line when the bubble is narrow. `align` — Cross-axis alignment; `children`* — Child ids, or a template over a data list; `justify` — Main-axis distribution.
- **Column** — Children stacked top to bottom. `align` — Cross-axis alignment; `children`* — Child ids, or a template over a data list; `justify` — Main-axis distribution.
- **List** — A list of items with separators; never scrolls, so keep it short (the widget is at most 600 px tall). `align` — Cross-axis alignment; `children`* — Child ids, or a template over a data list; `direction` — vertical (default) or horizontal (wraps).
- **Card** — A rounded panel around one child. `child`* — The child id.
- **Tabs** — Tabs switched on the device; only the open tab is shown. Up to 6 tabs. `tabs`* — Tabs: [{ title, child }].
- **Divider** — A thin separating line. `axis` — horizontal (default) or vertical.
- **Button** — A button. Its action either reaches the agent (event) or runs on the device (openUrl, copyText). `action`* — { event: { name, context?, userMessage? } } or { functionCall: { @call: openUrl|copyText, args } }; `child`* — Id of a Text (or Icon) shown on the button; `variant` — default, primary (main action) or borderless (looks like a link).
- **CheckBox** — A check mark the person toggles on the device; its value goes to the agent with an event in the same widget. `label`* — The label; `value`* — { @path } to a boolean in the data model.
- **ChoicePicker** — Options to pick on the device; the picked values go to the agent with an event in the same widget. `label` — The label above the options; `options`* — [{ label, value }], 2-30 options; value is a short id; `value`* — { @path } to a list of the picked option values in the data model; `variant` — mutuallyExclusive (one, default) or multipleSelection.
- **Table** — A table: header row and up to 20 rows of short cells. `columns`* — Header labels, up to 6; `rows`* — Rows of cells (strings or numbers), or { @path } to them.
- **Chart** — A chart drawn when the widget is built: bar, line or pie. `kind`* — bar, line or pie; `labels`* — Category labels, up to 24, or { @path }; `series`* — [{ name, values }] with one number per label; pie takes one series. Up to 4; `title` — Chart title; `unit` — Unit after values, such as ₽ or km.
- **Progress** — A progress bar. `label` — Text above the bar; `max` — The full value (default 100); `value`* — The current value.
- **Badge** — A short label in a colored pill. `text`* — The label; `tone` — neutral (default), accent, success, warning or danger.
- **Countdown** — Time left until a moment, ticking on the device. It shows time only and never notifies: use a reminder for that. `done`* — Text shown once the moment has passed; `label` — Text above the timer; `target`* — ISO 8601 moment with a UTC offset, such as 2026-12-31T23:59:00+03:00.
- **Quiz** — Questions with options, checked on the device. With finish, the score reaches the agent when the last answer is given. `finish` — Optional { event: { name, userMessage? } }: the agent gets { score, total }; `questions`* — [{ question, options: [2-4 strings], answer: index of the right option }], up to 10.

Functions (`{ "@call": name, "args": {...} }`):
- `formatString(value*)` — Text with data model values put in. value: Text with ${/absolute/path} or ${relative/path} placeholders; \${ is a literal ${.
- `formatNumber(decimals, grouping, value*)` — A number in Russian notation: 12 345,5. decimals: Digits after the point (default 0); grouping: Group thousands (default true); value: The number.
- `formatCurrency(currency*, decimals, value*)` — An amount with its currency: 1 500 ₽. currency: ISO 4217 code: RUB, USD, EUR; decimals: Digits after the point (default 0); value: The amount.
- `formatDate(format*, value*)` — A date or a moment in Russian, in the offset it was given with; time zones are never guessed. format: TR35 pattern: yyyy yy MMMM MMM MM M dd d EEEE E HH H mm ss, such as 'd MMMM, HH:mm'; value: ISO 8601: a date (2026-11-07) or a moment with its offset (2026-11-07T17:30:00+03:00).
- `pluralize(few, many, one, other*, value*)` — The Russian word form for a count. few: Form for 2-4: «занятия»; many: Form for 5-20: «занятий»; one: Form for 1, 21: «занятие»; other: Fallback form, required; value: The count.
- `and(values*)` — True when all are true. values: Booleans.
- `or(values*)` — True when any is true. values: Booleans.
- `not(value*)` — The opposite. value: A boolean.
- `openUrl(url*)` — Opens a web page after the person confirms its address. Only as a Button's action.functionCall. url: An https web page outside Telegram, up to 256 characters.
- `copyText(text*)` — Copies text; Telegram shows what was copied. Only as a Button's action.functionCall. text: 1-256 characters to copy.

Icon names: baby, bell, book, calendar, car, cart, check, clock, close, cloud, food, fire, gift, heart, home, info, location, mail, medicine, money, music, pet, phone, plane, rain, school, snow, sport, star, sun, task, trophy, user, users, warning.
<!-- catalog:end -->

## Presses

- A `Button` with `action.event` reaches you: `{"event": {"name": "menu_done", "context": {"dishes": {"@path": "/picked"}}, "userMessage": "Выбрала блюда"}}`. `name` is an identifier you recognise later; `context` collects what you need, resolved when the person presses; `userMessage` is a short human line.
- `CheckBox` and `ChoicePicker` keep their marks on the device; bind their `value` to a data model path and put that path into an event's `context`, and you get the marks with the press.
- The press arrives as the person's next message: `[Pressed «Готово» in your widget «Меню на неделю»]` followed by A2UI's `{"version":"1.0","action":{"name", "surfaceId", "sourceComponentId", "context", "userMessage", "timestamp"}}`. Answer it as their words. While it waits, a second press of the same person in the same widget is refused with «Ещё обрабатываю прошлое нажатие».
- `Quiz` with `finish` sends `{ score, total }` when the last answer is given.
- `openUrl` and `copyText` run on the device and never reach you. `openUrl` takes only https pages outside Telegram.
- Up to 8 buttons with events and 120 marks per widget.

## Updates

`update_widget` takes A2UI messages `{"version":"1.0","updateDataModel":{"surfaceId":"...","path":"/going","value":4}}`. The widget's HTML never changes after sending, so only bound texts and progress bars can change: `Text`, `Badge`, `Progress` values and labels that read the changed paths. A change of a list's length, a table, a chart, a tab title, a mark's initial state or a countdown's moment is refused: send a new widget instead. Telegram updates the widget silently, for everyone in the chat.

## Size and layout

- The bubble is 200-600 px wide (a phone is about 360) and at most 600 px tall; nothing scrolls. Split long content into `Tabs`, keep lists short, use `caption` texts sparingly.
- A built widget must fit 3800 bytes compressed; a too large one is refused with its size: cut rows, shorten texts, split into tabs.
- Up to 200 components.

## Caption

1-3 lines up to 300 characters: what the widget is and the facts a person acts on (a time, a place, an amount, a deadline). Some apps do not show widgets yet and show only the caption. After the widget, write only what it does not show.

## Examples

<!-- examples:start (generated from agent/lib/widgets/a2ui/widget-examples.ts) -->

Request «составь меню на неделю, я выберу», caption «Меню на неделю: отметьте блюда и нажмите «Готово»»:
```json
{"createSurface":{"catalogId":"urn:osinara:a2ui:telegram-widget:1","components":[{"children":["title","dishes","done"],"component":"Column","id":"root"},{"component":"Text","id":"title","text":"Меню на неделю","variant":"title"},{"component":"ChoicePicker","id":"dishes","label":"Что готовим?","value":{"@path":"/picked"},"variant":"multipleSelection","options":[{"label":"Борщ","value":"borsch"},{"label":"Плов","value":"plov"},{"label":"Сырники","value":"syrniki"},{"label":"Паста","value":"pasta"},{"label":"Котлеты","value":"cutlets"},{"label":"Рыба","value":"fish"}]},{"action":{"event":{"context":{"dishes":{"@path":"/picked"}},"name":"menu_done","userMessage":"Выбрала блюда на неделю"}},"child":"done_text","component":"Button","id":"done","variant":"primary"},{"component":"Text","id":"done_text","text":"Готово"}],"dataModel":{"picked":[]},"surfaceId":"menu_2026_11_09"},"version":"1.0"}
```

Request «покажи расписание кружков на неделю», caption «Кружки на неделю. Ближайшее — плавание у Пети, вт 17:30»:
```json
{"createSurface":{"catalogId":"urn:osinara:a2ui:telegram-widget:1","components":[{"component":"Tabs","id":"root","tabs":[{"child":"mon","title":"Пн"},{"child":"tue","title":"Вт"},{"child":"thu","title":"Чт"}]},{"children":{"componentId":"slot","path":"/mon"},"component":"List","id":"mon"},{"children":{"componentId":"slot","path":"/tue"},"component":"List","id":"tue"},{"children":{"componentId":"slot","path":"/thu"},"component":"List","id":"thu"},{"children":["slot_time","slot_name","slot_kid"],"component":"Row","id":"slot"},{"component":"Text","id":"slot_time","text":{"@path":"time"},"variant":"subtitle"},{"component":"Text","id":"slot_name","text":{"@path":"name"},"weight":1},{"component":"Badge","id":"slot_kid","text":{"@path":"kid"},"tone":"accent"}],"dataModel":{"mon":[{"kid":"Аня","name":"Английский","time":"16:00"}],"thu":[{"kid":"Аня","name":"Рисование","time":"18:00"},{"kid":"Петя","name":"Шахматы","time":"19:00"}],"tue":[{"kid":"Петя","name":"Плавание","time":"17:30"}]},"surfaceId":"clubs_week_46"},"version":"1.0"}
```

<!-- examples:end -->

## Your own HTML (a game or an animation)

Use `html` instead of `surface` only when the catalog cannot describe it: tic-tac-toe, a memory game, a reaction test, an animation. Such a widget is not connected to the bot: its taps never reach you, you cannot update it, and `TelegramWidget.request` does not work. Before sending, the application runs a quick check and Telegram's official check; a refusal lists what to fix.

- One self-contained document or fragment with inline `<style>` and `<script>`, at most 3800 bytes after compression: no comments, short names, no data: images beyond tiny icons. No network of any kind, no external scripts, styles, fonts or images, no form controls or keyboard, no `alert`, no libraries (draw with SVG or canvas).
- Colours only from Telegram's theme variables: `--tg-theme-bg-color`, `--tg-theme-text-color`, `--tg-theme-hint-color`, `--tg-theme-link-color`, `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-secondary-bg-color`. Fonts: `system-ui`, `sans-serif`, `serif`, `monospace` only. `body` has a margin of about `8px 12px`; `body{margin:0}` goes edge to edge.
- Lay out for 320-430 px with `%`, flex or grid; never `vh`. At most 600 px tall and nothing scrolls: use pages or tabs.
- Taps (`click`, pointer events) are the widget's; vertical drags always scroll the chat. For a horizontal slider or a held game button set `touch-action: pan-y` or `none` on it; keep controls 20 px from the left edge.
- `localStorage` keeps this widget's state on this device (4 KB): save the score or the board there. Timers run at most once a second off screen, and the widget may be recreated: restore from `localStorage` and draw the first frame at once.
- Limits: 2000 nodes, at most 16 elements with opacity, blur or a blurred shadow (mute with colour, not opacity), 300 ms of script per second, 8 MB of memory. Past them Telegram stops the widget.
- `window.TelegramWidget` gives `HapticFeedback.impactOccurred('light')`, `copyText(text)` and `openLink(url)` in a tap handler; it is undefined outside Telegram: check it.
- `height` (50-600) fixes the height for a canvas or an animation; otherwise the height follows the content.
