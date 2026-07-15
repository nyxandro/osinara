-- Existing user-bound grants become personal workspace profiles without another OAuth consent.
ALTER TABLE integration_accounts
  ADD COLUMN workspace_id uuid;

ALTER TABLE oauth_authorizations
  ADD COLUMN workspace_id uuid;

INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
SELECT DISTINCT legacy.family_id, legacy.user_id, NULL::uuid, 'personal'::memory_scope
FROM (
  SELECT family_id, user_id FROM integration_accounts
  UNION
  SELECT family_id, user_id FROM oauth_authorizations
) AS legacy
ON CONFLICT (family_id, scope, owner_user_id, group_id) DO NOTHING;

UPDATE integration_accounts AS account
SET workspace_id = workspace.id
FROM workspaces AS workspace
WHERE workspace.family_id = account.family_id
  AND workspace.owner_user_id = account.user_id
  AND workspace.scope = 'personal'
  AND account.workspace_id IS NULL;

-- Pending legacy links remain personal and future links carry an explicit target workspace.
UPDATE oauth_authorizations AS oauth_row
SET workspace_id = workspace.id
FROM workspaces AS workspace
WHERE workspace.family_id = oauth_row.family_id
  AND workspace.owner_user_id = oauth_row.user_id
  AND workspace.scope = 'personal'
  AND oauth_row.workspace_id IS NULL;
