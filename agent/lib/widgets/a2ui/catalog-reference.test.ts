/**
 * The widgets skill against the catalog it describes.
 *
 * Constructs covered:
 * - The catalog and the examples in SKILL.md are exactly what `catalog-reference.ts` generates from the
 *   catalog and the reference widgets (run `npx tsx scripts/widgets/generate-widget-skill.ts` after a change).
 * - Every component and function of the catalog is named in the skill.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { WIDGET_COMPONENTS, WIDGET_FUNCTIONS } from "./catalog.js";
import {
  CATALOG_REFERENCE_END,
  CATALOG_REFERENCE_START,
  catalogReference,
  EXAMPLES_REFERENCE_END,
  EXAMPLES_REFERENCE_START,
  examplesReference,
} from "./catalog-reference.js";

const SKILL = readFileSync("config/service-skills/widgets/SKILL.md", "utf8");

function block(start: string, end: string): string {
  return SKILL.slice(SKILL.indexOf(start), SKILL.indexOf(end) + end.length);
}

describe("widgets skill", () => {
  it("carries the generated catalog and examples", () => {
    expect(block(CATALOG_REFERENCE_START, CATALOG_REFERENCE_END)).toBe(catalogReference());
    expect(block(EXAMPLES_REFERENCE_START, EXAMPLES_REFERENCE_END)).toBe(examplesReference());
  });

  it("names every component and function of the catalog", () => {
    for (const name of Object.keys(WIDGET_COMPONENTS)) expect(SKILL).toContain(`**${name}**`);
    for (const name of Object.keys(WIDGET_FUNCTIONS)) expect(SKILL).toContain(`\`${name}(`);
  });
});
