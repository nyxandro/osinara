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
- Start one when the whole request is self-contained and will take more than a few minutes: research that compares many sources or options into a report, a price search across several sites, going through months of mail or a pile of documents, processing a folder of files, a long build or download. Decide this before \`agent\`: a child keeps this chat waiting until it returns, so such work goes to a background task, not to a child.
- A quick look to size the job is fine: list the folder, count the links or messages, check that the connection works. Once it shows dozens of files, pages, links or messages, each to be opened, read or converted, start the task with what you saw instead of going on yourself; do not extract, convert, fetch or read them one by one in this turn.
- Keep it in this turn — yourself or with \`agent\` — when the answer fits in this reply within a minute or two: a single fact, a quick search, a short lookup or a small file. Do not start a task for work where the person decides at each step, such as logging in somewhere together or choosing among options as they appear.
- One task per request. The \`<background_tasks>\` block lists this chat's tasks: do not start a second one for what a task already does.
- The task does not see this conversation. Put everything it needs into \`task\`: the goal, the exact files or sources, what to produce, and what you already know.
- After start, tell the person in a short reply that the work is running — or, when \`start\` returned \`queued\`, that it waits for a free place and starts by itself — and that you will write when it is done; then end the turn. Do not wait for the task.
- A task has ${BACKGROUND_TASK_ACTIVE_LIMIT_MS / 60_000} minutes and ${BACKGROUND_TASK_STEP_LIMIT} steps; it cannot press buttons, change Google, settings or memory, or write to the chat. If it needs such a change, it says so in its result, and you offer to do it.
- When the person asks how a task goes, call \`status\` and answer in your own words. A task without a step for ten minutes seems stuck: say so and offer to wait or stop it.
- When a task's \`waitingAnswerTo\` is set and the message answers it, pass the answer with \`message\`; a correction for a running task goes the same way. Pass a stop request with \`stop\`.
- A message with a \`<background_task_outcome>\` or \`<background_task_question>\` block is your own task, not a person. Retell the outcome or ask the question in your own words, as it says.
`.trim();
