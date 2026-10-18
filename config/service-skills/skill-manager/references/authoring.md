# Writing a skill

A skill is worth saving only when it carries what you would not know next time: the exact commands that worked, the parameters the person approved, the pitfalls you hit, the person's corrections. A skill written from general knowledge adds nothing; do not write one.

## Shape

- Folder `skills/<name>/` in the personal workspace: `SKILL.md`, and if needed `scripts/` and `references/`.
- `name`: lowercase Latin letters, digits and hyphens; not the name of a built-in skill.
- `description`: one line in Russian (the family reads it), up to 1024 characters — what the skill does, the phrases that should load it, direct and indirect, and when not to use it.
- Body in Russian, under 500 lines: steps in order, each naming the tool or command; a section «Проверка» — what to check before answering; a section «Типичные ошибки» from this conversation. Long material goes to `references/<topic>.md`, linked from the step that needs it, one level deep.
- No data of a particular person (see the rules in `SKILL.md`): write «подпись этого человека — из его личной памяти», never a name or a path.

## Scripts

- Put repeatable logic into `scripts/` instead of describing it, and say exactly how to run it: `python3 $HOME/.agents/skills/<name>/scripts/<file>.py …`. Never a path to the draft folder.
- Work in a temporary directory (`mktemp -d`), never fixed file names in the current directory. Write the result into the workspace of the current chat (personal in a private chat, family in a family chat) next to the input; never overwrite the input.
- List the Python or npm packages the scripts need, with the install command, and check them at the start: each chat has its own environment and may not have them.
- Cyrillic text in a PDF or an image needs a font that has it: `/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf` or another Liberation font there. Standard PDF fonts such as Times or Helvetica print squares.
- A document with several pages keeps its page order; look for things on every page, not only the first.
- Report a failure with a clear message, not a stack trace.

## Before saving

1. Run the draft on the real input of this conversation, or a similar one.
2. Check the result the way the person would: for a document, render the page and look at it with `inspect_workspace_image`.
3. Fix and repeat until it works, then `{"action":"save","path":"skills/<name>","scope":"personal"}`.
4. Tell the person in two or three lines what the skill does, how to ask for it, that it works for them from the next message, and that others enable it themselves.

## Fixing a skill

1. `{"action":"checkout","name":"<name>"}` writes the current version into `skills/<name>/`, replacing any old draft: always start from it.
2. Change, run, check as above, then `save`: the new version replaces the current one for everyone who has the skill, and they get a notice listing the changed files. `rollback` brings the previous version back.
