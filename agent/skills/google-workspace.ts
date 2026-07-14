/**
 * Personal-only dynamic Google Workspace skill.
 *
 * Exports:
 * - `GOOGLE_WORKSPACE_SCOPE_POLICY`: personal-only capability declaration.
 * - Dynamic `google-workspace` skill with safe gws command guidance.
 */
import { defineDynamic, defineSkill } from "eve/skills";

import {
  defineSkillScopePolicy,
  resolveAllowedSkillScope,
} from "../lib/skills/skill-scope-policy.js";

const GOOGLE_WORKSPACE_DESCRIPTION =
  "Use the user's connected Google Workspace account for Drive, Docs, Sheets, Calendar, Gmail, Tasks, or Chat operations through the structured google_workspace tool.";

const GOOGLE_WORKSPACE_INSTRUCTIONS = `# Google Workspace

Use \`google_workspace\` only for the current user's Google account in a private Telegram chat.

## Connect

If the tool returns \`AGENT_INTEGRATION_AUTH_REQUIRED\`, call it with \`{ "action": "connect" }\`.
Tell the user to open the protected link delivered separately by the bot, approve access, then retry.
Never ask the user to paste OAuth codes, access tokens, refresh tokens, or credentials into chat.

## Execute

Call \`action: "execute"\` with a structured Discovery command:

- \`service\`: \`drive\`, \`docs\`, \`sheets\`, \`calendar\`, \`gmail\`, \`tasks\`, or \`chat\`.
- \`resourcePath\`: resource and nested resource names, such as \`["files"]\` or \`["users", "messages"]\`.
- \`method\`: the final Discovery method, such as \`list\`, \`get\`, \`create\`, \`patch\`, or \`delete\`.
- \`params\`: URL and query parameters as an object.
- \`body\`: request JSON as an object.
- \`pageAll\` and \`pageLimit\`: bounded pagination for list operations.

Examples:

\`{ "action": "execute", "command": { "service": "drive", "resourcePath": ["files"], "method": "list", "params": { "pageSize": 20, "fields": "files(id,name,mimeType,modifiedTime)" } } }\`

\`{ "action": "execute", "command": { "service": "sheets", "resourcePath": ["spreadsheets", "values"], "method": "get", "params": { "spreadsheetId": "ID", "range": "Sheet1!A1:C10" } } }\`

\`{ "action": "execute", "command": { "service": "gmail", "resourcePath": ["users", "messages"], "method": "list", "params": { "userId": "me", "q": "is:unread" } } }\`

## Files

For media upload, add \`upload: { scope, path, contentType }\`. The path is relative to the authorized personal or family workspace.
For binary download, add \`output: { scope, path }\`; the downloaded bytes are written to that workspace path.
Never place host paths, shell commands, auth commands, \`schema\`, helper commands beginning with \`+\`, or arbitrary gws flags in tool input.

All possible mutations pause for explicit user confirmation. Do not split one requested mutation into additional unapproved mutations.`;

export const GOOGLE_WORKSPACE_SCOPE_POLICY = defineSkillScopePolicy({
  allowedScopes: ["personal"],
});

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const scope = resolveAllowedSkillScope(ctx.session.auth, GOOGLE_WORKSPACE_SCOPE_POLICY);
      if (!scope) return null;
      return defineSkill({
        description: GOOGLE_WORKSPACE_DESCRIPTION,
        markdown: GOOGLE_WORKSPACE_INSTRUCTIONS,
        metadata: {
          "osinara.allowed-scopes": GOOGLE_WORKSPACE_SCOPE_POLICY.allowedScopes.join(","),
          "osinara.runtime-scope": scope,
        },
      });
    },
  },
});
