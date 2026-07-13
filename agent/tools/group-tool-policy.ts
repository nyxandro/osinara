/**
 * Eve dynamic external-group tool policy.
 *
 * Export:
 * - Step-scoped tool overrides based only on verified Telegram group auth attributes.
 */
import { defineDynamic } from "eve/tools";

import {
  createExternalGroupToolOverrides,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/group-tool-policy.js";

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      const policy = resolveExternalGroupToolPolicy(ctx.session.auth);
      return policy.restricted ? createExternalGroupToolOverrides(policy.allowed) : null;
    },
  },
});
