/**
 * Local Eve Workflow recovery patch contract tests.
 *
 * Constructs covered:
 * - `reenqueueActiveRuns`: routes recovered runs through the configured queue namespace.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowWorldRuntime = new URL(
  "../../node_modules/eve/dist/src/compiled/_chunks/workflow/dist-DnBjuNAZ.js",
  import.meta.url,
);

describe("Eve local Workflow recovery patch", () => {
  it("re-enqueues active runs into the namespace registered by Eve", () => {
    const source = readFileSync(workflowWorldRuntime, "utf8");

    expect(source).toContain("`${Um(`workflow`,Hm())}${e.workflowName}`");
    expect(source).not.toContain("`__wkf_workflow_${e.workflowName}`");
  });
});
