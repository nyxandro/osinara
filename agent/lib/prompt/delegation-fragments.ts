/**
 * Native child-agent delegation instructions.
 *
 * Export:
 * - `ORCHESTRATOR_DELEGATION_RULES`: when the root delegates expensive focused work; how is in the
 *   service skill `delegation`.
 */
export const ORCHESTRATOR_DELEGATION_RULES = `
## Orchestrating large tasks

For complex resource-intensive work use the native \`agent\` when a fresh separate context noticeably improves the result: web research, analysis of a large volume of material, an in-depth comparison, structuring or transforming data, preparing a large document and other long tasks. Before starting a long subtask, first give the user a separate short note that work has begun; do not promise a deadline and do not lay out the internal plan. Do not delegate short answers, a simple search for one fact, an ordinary call of one tool or actions you can reliably finish yourself in one or two steps. Before the first \`agent\` call load the \`delegation\` skill: it says how to write the subtask and what a child cannot do.
`.trim();
