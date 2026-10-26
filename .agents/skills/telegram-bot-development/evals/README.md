# Evals for telegram-bot-development

`evals.json` holds the tasks, their assertions and the results of past runs. Each task runs twice —
with the skill and without it — and the answers are graded against the assertions.

Tasks 1–3 check that the answer uses the current Bot API at all; under rules that already forbid
coding from memory, both configurations pass them (see `iteration_1`). Tasks 4–6 are built
around facts that are easy to get wrong even when reading the docs: rich-message tables and
drafts listed only on their own docs page, the Stars fee attached to private-chat topics in the
developer terms, and a parameter that is alive in one method and replaced in another.

## Fixture projects

Prompts name a project with a library installed. Build them outside the skill directory:

```bash
# tasks 1 and 4: aiogram 3.31 (declares Bot API 10.3)
mkdir aiogram-bot && cd aiogram-bot && uv venv --python 3.12 .venv \
  && VIRTUAL_ENV=$PWD/.venv uv pip install aiogram==3.31.0 && cp <skill>/evals/files/aiogram_bot.py bot.py

# task 2: python-telegram-bot 22.8 (declares Bot API 10.0, no ephemeral messages)
mkdir ptb-bot && cd ptb-bot && uv venv --python 3.12 .venv \
  && VIRTUAL_ENV=$PWD/.venv uv pip install python-telegram-bot==22.8

# task 6: grammY 1.46.0 with @grammyjs/types 5.0.0
mkdir grammy-bot && cd grammy-bot && npm init -y && npm install grammy@1.46.0 \
  && cp <skill>/evals/files/grammy_rules.ts bot.ts
```

Then replace the `<a project …>` placeholder in the prompt with the fixture's path. Runs must
not change the fixture: they write their answer and changed files to their own output folder.
