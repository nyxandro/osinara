-- Existing user-bound grants become personal workspace profiles without another OAuth consent.
ALTER TABLE integration_accounts
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;

INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
SELECT DISTINCT family_id, user_id, NULL::uuid, 'personal'::memory_scope
FROM integration_accounts
ON CONFLICT (family_id, scope, owner_user_id, group_id) DO NOTHING;

UPDATE integration_accounts AS account
SET workspace_id = workspace.id
FROM workspaces AS workspace
WHERE workspace.family_id = account.family_id
  AND workspace.owner_user_id = account.user_id
  AND workspace.scope = 'personal';

ALTER TABLE integration_accounts
  ALTER COLUMN workspace_id SET NOT NULL;

DROP INDEX integration_accounts_one_default;
ALTER TABLE integration_accounts
  DROP CONSTRAINT integration_accounts_user_id_provider_external_account_id_key;
ALTER TABLE integration_accounts
  DROP CONSTRAINT integration_accounts_user_id_fkey;
ALTER TABLE integration_accounts
  RENAME COLUMN user_id TO connected_by_user_id;
ALTER TABLE integration_accounts
  ALTER COLUMN connected_by_user_id DROP NOT NULL;
ALTER TABLE integration_accounts
  ADD CONSTRAINT integration_accounts_connected_by_user_id_fkey
  FOREIGN KEY (connected_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE integration_accounts
  ADD CONSTRAINT integration_accounts_workspace_provider_external_account_key
  UNIQUE (workspace_id, provider, external_account_id);
CREATE UNIQUE INDEX integration_accounts_one_default
  ON integration_accounts (workspace_id, provider)
  WHERE is_default AND status <> 'revoked';

-- Pending legacy links remain personal and future links carry an explicit target workspace.
ALTER TABLE oauth_authorizations
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;

INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
SELECT DISTINCT family_id, user_id, NULL::uuid, 'personal'::memory_scope
FROM oauth_authorizations
ON CONFLICT (family_id, scope, owner_user_id, group_id) DO NOTHING;

UPDATE oauth_authorizations AS oauth_row
SET workspace_id = workspace.id
FROM workspaces AS workspace
WHERE workspace.family_id = oauth_row.family_id
  AND workspace.owner_user_id = oauth_row.user_id
  AND workspace.scope = 'personal';

ALTER TABLE oauth_authorizations
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE oauth_authorizations
  RENAME COLUMN user_id TO actor_user_id;

-- Native gws commands own execution; the removed API proxy no longer needs call markers.
DROP TABLE integration_operations;
