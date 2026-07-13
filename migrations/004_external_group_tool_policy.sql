-- Family groups use the normal family tool surface; only external groups persist an allowlist.
UPDATE telegram_groups
SET tool_allowlist = '{}'
WHERE type = 'family_private' AND cardinality(tool_allowlist) > 0;

ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_family_allowlist_empty
  CHECK (type <> 'family_private' OR cardinality(tool_allowlist) = 0);
