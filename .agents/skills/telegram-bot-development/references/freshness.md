# Staying on the current Bot API

**Load this when** you are about to call a Bot API method, review code that does, pick between two ways of doing something, answer "can a bot do X?", or the user reports that a method or parameter "does not exist" or "does not work".

## Why memory is not a source

The Bot API ships roughly every month, and a release can replace what the previous one added. Run `python3 scripts/tgdocs.py history receiver_user_id` to see it happen: two parameters added to every send method in one release were replaced by a new object in the next. Training data is months behind the live API at best, so a method signature written from memory is a guess — sometimes a parameter that no longer exists, sometimes a workaround for something the API now does natively (streaming a reply by editing a message once a second, when the API has a native draft for that).

The fix is cheap: the official docs are machine-readable, and the installed library can be searched in a second.

## Where the truth is, in order

1. **The official docs at core.telegram.org**, in their Markdown form — one page per method (`/bots/api/methods/<name>.md`), per type (`/bots/api/types/<name>.md`), the changelog, and the guides. `scripts/tgdocs.py index` prints Telegram's own map of them (`llms.txt`).
2. **The code of the library the project has installed** — what it can actually send. `scripts/find_method_support.py`.
3. **The library's own changelog and docs** — for how it exposes a method, and for when it added one.
4. **Community guides, blog posts, other skills** — useful for patterns, often stale on facts. Example: a widely read framework guide states one Stars threshold for paid broadcasts while the official FAQ states another; the FAQ wins.
5. **Memory** — only for what to look up.

When sources disagree, the official page wins, and say in your answer that they disagree.

Every number these references quote names where to re-check it. The ones that can change without any entry in the changelog — the Stars fee for private-chat topics, the draft rate limits — are written in one file each (`payments-stars.md`, `ai-bots.md`), with the month they were checked and the command that shows the live value. Before giving any of these numbers to the owner as a fact, run that command or read that page; if the live source says something else, it wins, and say that the skill is out of date.

## The loop

1. **What is current.** `tgdocs.py latest` — the newest version and date.
2. **What changed since what you (or the library) know.** `tgdocs.py changes --since <version>`. Use the version the installed library declares if it declares one, otherwise the version you remember. Read the whole output: a release often touches methods you did not think were related.
3. **The exact contract of each method and type you touch.** `tgdocs.py method <name>`, `tgdocs.py type <name>`. Use the documented parameter names, limits and notes, not the ones you remember. If you do not know the name: `tgdocs.py search <word>`. It matches names and one-line summaries on the index and every reference page the index links to (rich-message methods and types are listed only on their own page), and tries the exact method or type page when no index lists the name. Parameters and fields are not indexed: for them, `history` and the method pages.
4. **Whether a name is still alive.** `tgdocs.py history <name>` lists every changelog line mentioning it, by version: added, extended, replaced, deprecated.
5. **Whether the project's library knows it.** `scripts/find_method_support.py <name> ... --root <project>`. It prints each Telegram library found, its version, the Bot API version it declares when it declares one, and the lines where each name occurs. For a parameter, ask for it on its method — `sendMessage.ephemeral_message_parameters`: a bare name only says the library mentions it somewhere, and one name can be alive in one place and replaced in another (since 10.3 `receiver_user_id` is a field of `EphemeralMessageParameters` and a parameter of the `editEphemeralMessage…` and `deleteEphemeralMessage` methods, but no longer of `sendMessage`). The `method.parameter` check reads the code around each definition rather than parsing the language: a function's parameter list up to its closing bracket, a class's or struct's fields, with comments and docstrings ignored, and a parameter counts only where it is declared or passed (`chat_id:`, `text=`, `"chat_id":`, `json:"chat_id"`). Open the lines it prints before relying on it. A library core that takes optional parameters as one object typed elsewhere (grammY's `other`, node-telegram-bot-api's `form`, PHP arrays) shows MISSING for them — look at its types package (`@grammyjs/types` for grammY) or its code.
6. **Capability questions.** Before answering "a bot cannot do X": `tgdocs.py page bots/features --toc`, then `--section "<heading>"`, and `tgdocs.py search <word>`. New capabilities appear in the features page and the changelog first.

Say in your answer what you checked: "checked against Bot API <version> docs on <date>; <library> <version> supports it / does not".

## When the library is behind the API

`find_method_support.py` reports `MISSING` for a method the docs have. Options, best first:

1. **A newer release of the library supports it.** Check the library's changelog or registry; upgrading is a dependency change — follow the project's rules for that.
2. **Call the method raw through the library**, keeping its HTTP client, token handling and error mapping. Known escape hatches — verify against the installed version before relying on one:
   - grammY: `api.raw.<method>(payload)` (unknown methods need a type assertion);
   - Telegraf: `telegram.callApi('<method>', payload)` (typed to the methods its bundled types know: newer methods need a type assertion). When this was written (October 2026), its latest release was 4.16.3 of February 2024, built on types for Bot API 7.1 (`@telegraf/types ^7.1.0`; re-check with `npm view telegraf version dependencies`) — everything newer is a raw call. In an existing Telegraf bot, show the owner how much of what it needs came after 7.1 (`changes --since 7.1`) before choosing between raw calls and moving to a maintained library; for a new bot, do not pick Telegraf;
   - python-telegram-bot: `bot.do_api_request('<method>', api_kwargs={...})`;
   - aiogram: a subclass of `aiogram.methods.base.TelegramMethod`;
   - any library: an HTTPS POST of JSON to `https://api.telegram.org/bot<token>/<method>`.
3. **Put the raw call in one small adapter** with a comment naming the docs page and the library version that lacked it, so it is removed when the library catches up. Never scatter raw calls through handlers.

The reverse also happens: the library still exposes a parameter the API has replaced. The docs decide; the library's old field is a trap. Example: aiogram 3.31, which declares Bot API 10.3, still accepts `receiver_user_id` on `send_message`, marked deprecated since 10.3 — `find_method_support.py` reports it as found, because the library can send it. Only the method page says whether Telegram still documents it.

## Reading the docs well

- Prefer `.md` pages: the HTML reference is close to a megabyte and fetch tools truncate it.
- Method pages list every parameter with its limits ("1-4096 characters after entities parsing") — limits live there, not in memory.
- Guides worth knowing by path: `bots/features` (every capability, BotFather settings), `bots/faq` (limits, files, broadcasting), `bots/webhooks`, `bots/webapps` (Mini Apps), `bots/payments-stars`, `bots/payments`, `bots/api/formatting`, `bots/api/rich-messages`, `bots/serverless`, `bots/inline`.
- Some facts about bots live on the client-API (MTProto) side of the docs, under `api/`: `api/bots/ai` holds the rate limits for streaming drafts. `tgdocs.py page` reads those pages too.
- The developer terms (`https://telegram.org/tos/bot-developers`) are not on core.telegram.org and have no Markdown form; read them when data handling, payments or AI is involved with `tgdocs.py terms --toc`, then `terms --section <number>`, which prints the clause verbatim. Do not add `.md` to their address: telegram.org then serves the general Terms of Service, with no error. A fetch tool that retells pages through another model can change a number; quote the clause instead.
- `error_code` values in error responses are "subject to change" per the docs; match on the documented `parameters` (such as `retry_after`) where they exist.

## Offline or blocked

If the docs cannot be reached, say so plainly, mark what you write as unverified against the current API, and name the pages that must be checked. `tgdocs.py --allow-stale` uses a cached copy and prints its age; use it only when the user accepts that.
