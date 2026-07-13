-- The standalone PDF parser and its model-facing tool were removed in favor of the native PDF skill.
UPDATE telegram_groups
   SET tool_allowlist = array_remove(tool_allowlist, 'inspect_workspace_pdf')
 WHERE tool_allowlist @> ARRAY['inspect_workspace_pdf']::text[];
