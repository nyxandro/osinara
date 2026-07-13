UPDATE telegram_groups
   SET tool_allowlist = array_remove(
     array_remove(
       array_remove(
         array_remove(tool_allowlist, 'list_workspace_files'),
         'search_workspace_files'
       ),
       'read_workspace_file'
     ),
     'write_workspace_file'
   )
 WHERE tool_allowlist && ARRAY[
   'list_workspace_files',
   'search_workspace_files',
   'read_workspace_file',
   'write_workspace_file'
 ]::text[];
