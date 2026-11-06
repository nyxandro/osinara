/**
 * Rewrites the generated blocks of the widgets skill from the catalog and the reference examples.
 *
 * Run after changing `agent/lib/widgets/a2ui/catalog.ts` or `widget-examples.ts`:
 *   npx tsx scripts/widgets/generate-widget-skill.ts
 * The skill test fails until the committed SKILL.md matches what this writes.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  CATALOG_REFERENCE_END,
  CATALOG_REFERENCE_START,
  catalogReference,
  EXAMPLES_REFERENCE_END,
  EXAMPLES_REFERENCE_START,
  examplesReference,
  replaceGeneratedBlock,
} from "../../agent/lib/widgets/a2ui/catalog-reference.js";

const SKILL_PATH = "config/service-skills/widgets/SKILL.md";

const current = readFileSync(SKILL_PATH, "utf8");
const withCatalog = replaceGeneratedBlock(current, CATALOG_REFERENCE_START, CATALOG_REFERENCE_END, catalogReference());
const next = replaceGeneratedBlock(withCatalog, EXAMPLES_REFERENCE_START, EXAMPLES_REFERENCE_END, examplesReference());
writeFileSync(SKILL_PATH, next, "utf8");
console.log(next === current ? "widgets skill is up to date" : "widgets skill updated");
