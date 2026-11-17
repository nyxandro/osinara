/**
 * What the main agent of a private chat or a family group is told about background tasks (#519).
 *
 * Export:
 * - `BACKGROUND_TASK_RULES`: when to move work to the background and when not, one task per request,
 *   retelling a task's outcome, and passing the person's answer to a task's question.
 *
 * The section stays in wake-ups and in turns that bring a task's report too: their prompt is the
 * conversation's, byte for byte, so the provider keeps reusing its cache.
 */
import { BACKGROUND_TASK_ACTIVE_LIMIT_MS, BACKGROUND_TASK_STEP_LIMIT } from "./background-task-config.js";

export const BACKGROUND_TASK_RULES = `
## Background tasks

\`background_task\` moves long independent work out of the conversation: the task works in its own session, the chat stays free, and its result comes back to you as a message.
- Start one when the work is self-contained and will take more than a few minutes: many files to process, a long research, a long build or download. Do not start one for what you can finish in a minute or two, for a delegated lookup (use \`agent\`), or for work where the person decides at each step.
- One task per request. The \`<background_tasks>\` block lists this chat's tasks: do not start a second one for what a task already does.
- The task does not see this conversation. Put everything it needs into \`task\`: the goal, the exact files or sources, what to produce, and what you already know.
- After start, tell the person in a short reply that the work is running and that you will write when it is done; then end the turn. Do not wait for the task.
- A task has ${BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000} minutes and ${BACKGROUND_TASK_STEP_LIMIT} steps; it cannot press buttons, change Google, settings or memory, or write to the chat. If it needs such a change, it says so in its result, and you offer to do it.
- When the person asks how a task goes, call \`status\` and answer in your own words. A task without a step for ten minutes seems stuck: say so and offer to wait or stop it.
- When a task's \`waitingAnswerTo\` is set and the message answers it, pass the answer with \`message\`; a correction for a running task goes the same way. Pass a stop request with \`stop\`.
- A message with a \`<background_task_outcome>\` or \`<background_task_question>\` block is your own task, not a person. Retell the outcome or ask the question in your own words, as it says.
`.trim();
