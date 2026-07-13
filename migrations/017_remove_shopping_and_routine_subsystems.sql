DROP TABLE shopping_operations;
DROP TABLE shopping_items;
DROP TABLE shopping_lists;
DROP TYPE shopping_item_status;
DROP TYPE shopping_list_status;

DROP TABLE routine_observation_events;
DROP TABLE routine_observations;

-- Preserve exact external-group permissions while replacing tool-level memory mutations.
UPDATE telegram_groups
SET tool_allowlist = array_remove(
  array_remove(
    array_replace(
      array_replace(
        array_replace(
          array_replace(tool_allowlist, 'edit_memory', 'manage_memory.edit'),
          'forget',
          'manage_memory.delete'
        ),
        'undo_memory',
        'manage_memory.undo'
      ),
      'delete_workspace_file',
      'remove_group_file'
    ),
    'move_workspace_file'
  ),
  'observe_routine'
);
