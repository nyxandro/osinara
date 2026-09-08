/**
 * Internal route that cancels Telegram HITL approvals nobody confirmed in time.
 *
 * Export:
 * - Authored channel owning the private timeout sweep route.
 *
 * Key constructs:
 * - `attachSession` is exposed only to route handlers, so the sweep must run behind this route.
 * - The route is absent from the edge allowlist and additionally requires the internal token.
 */
import { defineChannel, POST } from "eve/channels";

import { finalizeTimedOutPrompt } from "../lib/telegram-hitl/approval-timeout-prompt.js";
import { approvalTimeoutRepository } from "../lib/telegram-hitl/approval-timeout-repository.js";
import {
  APPROVAL_TIMEOUT_ROUTE,
  APPROVAL_TIMEOUT_TOKEN_HEADER,
  isInternalTokenAuthorized,
  requireInternalToken,
} from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { createApprovalTimeoutResolver } from "../lib/telegram-hitl/approval-timeout.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { runtimeHandoffSession } from "../lib/runtime-handoff.js";

export default defineChannel({
  routes: [
    POST(APPROVAL_TIMEOUT_ROUTE, async (request, { attachSession }) => {
      const presented = request.headers.get(APPROVAL_TIMEOUT_TOKEN_HEADER);
      if (!isInternalTokenAuthorized(presented, requireInternalToken())) {
        return new Response(null, { status: 404 });
      }
      const resolved = await withRuntimeAdmission("callback", admissionId => createApprovalTimeoutResolver({
        attachSession: sessionId => runtimeHandoffSession(attachSession(sessionId), admissionId),
        finalizePrompt: finalizeTimedOutPrompt,
        repository: approvalTimeoutRepository,
      })(new Date()));
      return Response.json(resolved === null ? { paused: true } : { resolved });
    }),
  ],
});
