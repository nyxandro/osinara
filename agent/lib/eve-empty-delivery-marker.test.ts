/**
 * Eve empty-delivery marker contract tests.
 *
 * Constructs covered:
 * - The marker the prompt teaches the model is the exact string Eve 0.40.0 honours.
 * - Eve honours the marker in every turn: the channel receives `message: null`, the step never
 *   enters history, and no empty-response recovery fires.
 * - Eve documents the marker only to scheduled and task turns, so the application prompt owns it.
 * - The install-time patch pins this internal contract so an Eve update cannot change it silently.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EVE_EMPTY_DELIVERY_MARKER } from "./eve-empty-delivery.js";

const EMPTY_DELIVERY_PATH = "node_modules/eve/dist/src/shared/empty-delivery.js";
const EMISSION_PATH = "node_modules/eve/dist/src/harness/emission.js";
const TOOL_LOOP_PATH = "node_modules/eve/dist/src/harness/tool-loop.js";

describe("Eve empty-delivery marker", () => {
  it("matches the sentinel Eve compares against by substring", async () => {
    const runtime = await readFile(EMPTY_DELIVERY_PATH, "utf8");

    expect(EVE_EMPTY_DELIVERY_MARKER).toBe("<eve-empty-delivery/>");
    expect(runtime).toContain(`EMPTY_DELIVERY_SENTINEL=\`${EVE_EMPTY_DELIVERY_MARKER}\``);
    expect(runtime).toContain(
      `function hasEmptyDeliverySentinel(e){return e?.includes(\`${EVE_EMPTY_DELIVERY_MARKER}\`)??!1}`,
    );
  });

  it("turns a marked final answer into an undelivered step without any nudge", async () => {
    const [emission, toolLoop] = await Promise.all([
      readFile(EMISSION_PATH, "utf8"),
      readFile(TOOL_LOOP_PATH, "utf8"),
    ]);

    // The channel learns about silence through `message: null`, never through visible text.
    expect(emission).toContain(
      "p!==`tool-calls`&&hasEmptyDeliverySentinel(f)?await a(createMessageCompletedEvent({finishReason:p,message:null,",
    );
    // A marked step leaves no assistant message in history and is not an empty response.
    expect(toolLoop).toContain(
      "l=i.finishReason!==`tool-calls`&&i.toolCalls.length===0&&hasEmptyDeliverySentinel(c)",
    );
    expect(toolLoop).toContain("f=l?[]:appendMissingToolResultMessages(");
    expect(toolLoop).toContain("p=l?null:c");
    // Eve tells only scheduled and task turns about the marker; ordinary chats hear it from us.
    expect(toolLoop).toContain("ye&&J.push({role:`system`,content:CONDITIONAL_DELIVERY_INSTRUCTION})");
    expect(toolLoop).toContain("buildEmptyResponseNudge(e.emptyDeliveryEnabled)");
  });

  it("is pinned by the install-time patch, not merely assumed", async () => {
    const patchSource = await readFile("scripts/apply-eve-patches.ts", "utf8");

    // The patch cannot import from `agent/` (Docker installs dependencies before copying it), so the
    // two literals are kept equal here.
    expect(patchSource).toContain(`const EVE_EMPTY_DELIVERY_MARKER = "${EVE_EMPTY_DELIVERY_MARKER}";`);
    expect(patchSource).toContain("hasEmptyDeliverySentinel(f)?await a(createMessageCompletedEvent({finishReason:p,message:null,");
    expect(patchSource).toContain("hasEmptyDeliverySentinel(c)");
  });
});
