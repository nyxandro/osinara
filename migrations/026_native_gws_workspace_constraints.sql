-- Validate the workspace backfill before tightening columns and renaming ownership fields.
ALTER TABLE integration_accounts
  ADD CONSTRAINT integration_accounts_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT integration_accounts_workspace_id_not_null
  CHECK (workspace_id IS NOT NULL) NOT VALID;
ALTER TABLE integration_accounts
  VALIDATE CONSTRAINT integration_accounts_workspace_id_fkey;
ALTER TABLE integration_accounts
  VALIDATE CONSTRAINT integration_accounts_workspace_id_not_null;
ALTER TABLE integration_accounts
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE integration_accounts
  DROP CONSTRAINT integration_accounts_workspace_id_not_null;

ALTER TABLE oauth_authorizations
  ADD CONSTRAINT oauth_authorizations_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT oauth_authorizations_workspace_id_not_null
  CHECK (workspace_id IS NOT NULL) NOT VALID;
ALTER TABLE oauth_authorizations
  VALIDATE CONSTRAINT oauth_authorizations_workspace_id_fkey;
ALTER TABLE oauth_authorizations
  VALIDATE CONSTRAINT oauth_authorizations_workspace_id_not_null;
ALTER TABLE oauth_authorizations
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE oauth_authorizations
  DROP CONSTRAINT oauth_authorizations_workspace_id_not_null;

-- Rebuild uniqueness around workspace profiles instead of user-bound grants.
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
  FOREIGN KEY (connected_by_user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE integration_accounts
  VALIDATE CONSTRAINT integration_accounts_connected_by_user_id_fkey;
ALTER TABLE integration_accounts
  ADD CONSTRAINT integration_accounts_workspace_provider_external_account_key
  UNIQUE (workspace_id, provider, external_account_id);
CREATE UNIQUE INDEX integration_accounts_one_default
  ON integration_accounts (workspace_id, provider)
  WHERE is_default AND status <> 'revoked';

ALTER TABLE oauth_authorizations
  RENAME COLUMN user_id TO actor_user_id;
