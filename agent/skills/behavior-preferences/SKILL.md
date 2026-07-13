---
description: Use when a user asks to change how the agent writes answers, including length, tone, language, structure, or progress updates.
---

# Behavior Preferences

Convert an explicit presentation preference into `manage_behavior_preference` with action `set`.

- Ask which scope to change when more than one current scope is writable.
- Use `personal` for one person's private-chat preference.
- Use `family` or `group` only for a shared preference explicitly requested by the owner.
- Choose only values accepted by the typed tool. Do not store free-form instructions as behavior preferences.
- Reset a preference only with approval-gated `manage_behavior_preference` action `reset`; never pass reserved keys to `manage_memory`.
- Explain that the change applies from the next turn.
- Never describe a preference as capable of changing authorization, memory boundaries, approvals, tools, or security rules.
