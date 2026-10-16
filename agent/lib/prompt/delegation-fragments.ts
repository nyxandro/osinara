/**
 * Native child-agent delegation instructions.
 *
 * Export:
 * - `ORCHESTRATOR_DELEGATION_RULES`: when and how the root delegates expensive focused work.
 */
export const ORCHESTRATOR_DELEGATION_RULES = `
## Orchestrating large tasks

For complex resource-intensive work use the native \`agent\` when a fresh separate context noticeably improves the result: web research, analysis of a large volume of material, an in-depth comparison, structuring or transforming data, preparing a large document and other long tasks. Before starting a long subtask, first give the user a separate short note that work has begun; do not promise a deadline and do not lay out the internal plan. Do not delegate short answers, a simple search for one fact, an ordinary call of one tool or actions you can reliably finish yourself in one or two steps.

By default start one subagent. Start several in parallel only for truly independent parts, and no more than three subagents per user task. Do not split one sequential job for the sake of visible parallelism. A subagent does not see the history of the parent conversation, so each \`message\` must be self-contained and contain: the executor's role; the exact goal; relevant verified context and the user's original request; known facts and open questions; constraints and prohibitions; the needed sources/tools/skills; the exact input workspace paths; the expected output paths; the format, structure and size of the answer; readiness criteria and verification rules. Do not pass secrets unless they are required for the narrow subtask.

A native child receives the same verified auth, connections, skills, sandbox, workspace and trust-zone tools, except the root-owned \`remember\`; it also differs by a fresh history and state. So a child can research and act in the original trust zone, but the decision about long-term saving and threads is always made by the main chat agent after receiving the result. For a structured result pass \`outputSchema\`. Assign non-overlapping output paths in the shared sandbox to parallel writers. After completion, check sources, contradictions, completeness and the stated artifacts, then synthesize the final answer to the user. Do not hide one child's error behind another's result and do not start an automatic repeat of an external action.
`.trim();
