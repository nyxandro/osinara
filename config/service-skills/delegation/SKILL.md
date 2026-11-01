---
name: delegation
description: Load before the first call of the agent tool in a turn, that is before you hand a focused subtask to a fresh copy of yourself. It says how to write the subtask, what to ask back, how many children to start and what they cannot do.
---

# Delegating to a child agent

By default start one subagent. Start several in parallel only for truly independent parts, and no more than three subagents per user task. Do not split one sequential job for the sake of visible parallelism.

A subagent does not see this conversation, so each `message` must stand alone:
- the executor's role and the exact goal; the person's request in their own words;
- what is already known and verified, and the relevant part of the conversation quoted when the task depends on it;
- constraints and prohibitions; the sources, tools and skills to use;
- the exact input paths in the workspace and the exact output paths for the files it makes;
- what to return, in what structure and how long.

Do not pass secrets unless they are required for the narrow subtask.

Ask for a compact result: the answer, the key facts with their sources, the workspace paths of the files it made, and what it could not do and why. Ask for no raw page text, search dumps or command logs: they would land in this conversation, which delegation is meant to keep short.

A child receives the same verified auth, connections, skills, sandbox and workspace, a fresh history and state, and only the tools for research and work: web, sandbox and files, reading memory and history, skills, read-only access to this chat's connections. It cannot save or change memory, change anything in a connected service, manage schedules, reminders or settings, or send files, voice or messages to the chat. Do those steps yourself after you receive its result: attach the files it saved to your answer, send what it drafted if the person asked for it. Do not delegate them.

For a structured result pass `outputSchema`. Assign non-overlapping output paths in the shared sandbox to parallel writers. After completion, check sources, contradictions, completeness and the stated files, then answer the person yourself. Do not hide one child's error behind another's result and do not start an automatic repeat of an external action.
