---
name: gws-calendar-agenda
description: "Google Calendar: Show upcoming events across all calendars."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws calendar +agenda --help"
---

# calendar +agenda

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

Show upcoming events across all calendars

## Usage

Call `execute_google_workspace`:

```json
{"argv":["calendar","+agenda"]}
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--today` | - | - | Show today's events |
| `--tomorrow` | - | - | Show tomorrow's events |
| `--week` | - | - | Show this week's events |
| `--days` | - | - | Number of days ahead to show |
| `--calendar` | - | - | Filter to specific calendar name or ID |
| `--timezone` | - | - | IANA timezone override (e.g. America/Denver). Defaults to Google account timezone. |

## Examples

```json
{"argv":["calendar","+agenda","--today"]}
{"argv":["calendar","+agenda","--week"]}
{"argv":["calendar","+agenda","--days","3","--calendar","Work"]}
{"argv":["calendar","+agenda","--today","--timezone","America/New_York"]}
```

## Tips

- Read-only - never modifies events.
- Queries all calendars by default; use --calendar to filter.
- Uses your Google account timezone by default; override with --timezone.

## See Also

- [gws-shared](../gws-shared/SKILL.md) - Global flags and auth
- [gws-calendar](../gws-calendar/SKILL.md) - All manage calendars and events commands
