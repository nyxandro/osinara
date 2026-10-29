---
name: delegation
description: Load before the first call of the agent tool in a turn, that is before you hand a focused subtask to a fresh copy of yourself. It says how to write the subtask, how many children to start and what they cannot do.
---

# Delegating to a child agent

By default start one subagent. Start several in parallel only for truly independent parts, and no more than three subagents per user task. Do not split one sequential job for the sake of visible parallelism.

A subagent does not see the history of the parent conversation, so each `message` must be self-contained and contain: the executor's role; the exact goal; relevant verified context and the user's original request; known facts and open questions; constraints and prohibitions; the needed sources, tools and skills; the exact input workspace paths; the expected output paths; the format, structure and size of the answer; readiness criteria and verification rules. Do not pass secrets unless they are required for the narrow subtask.

A child receives the same verified auth, connections, skills, sandbox and workspace, a fresh history and state, and only the tools for research and work: web, sandbox and files, reading memory and history, skills, reading Google Workspace. It cannot save or change memory, change anything in Google Workspace, manage schedules, reminders, groups, invitations or settings, or send files and voice messages to the chat: those steps stay with you after you receive its result, so do not delegate them.

For a structured result pass `outputSchema`. Assign non-overlapping output paths in the shared sandbox to parallel writers. After completion, check sources, contradictions, completeness and the stated artifacts, then synthesize the final answer to the user. Do not hide one child's error behind another's result and do not start an automatic repeat of an external action.
