/**
 * Google Workspace commands that open the user's data to other people.
 *
 * Export:
 * - `GOOGLE_WORKSPACE_ACCESS_GRANT_ROUTES`: reviewed mutation routes that wait for the owner's button.
 *
 * Every other mutation runs at once. These stay behind the button because text in a read email or
 * page can try to make the model hand the mailbox, files or calendar to an outsider, and such a grant
 * keeps working silently long after the turn. Revoking access is not on the list. A Drive revision
 * update is here because it can publish a Docs, Sheets or Slides file to the web.
 */
export const GOOGLE_WORKSPACE_ACCESS_GRANT_ROUTES: ReadonlySet<string> = new Set([
  "calendar acl insert",
  "calendar acl patch",
  "calendar acl update",
  "drive accessproposals resolve",
  "drive permissions create",
  "drive permissions update",
  "drive revisions update",
  "gmail users settings delegates create",
  "gmail users settings filters create",
  "gmail users settings forwardingAddresses create",
  "gmail users settings sendAs create",
  "gmail users settings sendAs patch",
  "gmail users settings sendAs update",
  "gmail users settings updateAutoForwarding",
]);
