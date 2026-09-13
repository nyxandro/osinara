---
name: gws-gmail-triage
description: "Gmail: Show unread inbox summary (sender, subject, date)."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws gmail +triage --help"
---

# gmail +triage

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

Show unread inbox summary (sender, subject, date)

## Usage

Call `execute_google_workspace`:

```json
{"argv":["gmail","+triage"]}
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--max` | - | 20 | Maximum messages to show (default: 20) |
| `--query` | - | - | Gmail search query (default: is:unread) |
| `--labels` | - | - | Include label names in output |

## Examples

```json
{"argv":["gmail","+triage","--max","5","--query","from:boss"]}
{"argv":["gmail","+triage","--max","10","--labels"]}
{"argv":["gmail","+triage","--labels"]}
```

## Tips

- Read-only - never modifies your mailbox.
- Defaults to table output format.

## See Also

- [gws-shared](../gws-shared/SKILL.md) - Global flags and auth
- [gws-gmail](../gws-gmail/SKILL.md) - All send, read, and manage email commands
