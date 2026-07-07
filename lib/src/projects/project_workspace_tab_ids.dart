/// Tab id helpers for project workspace tabs.
///
/// Key constructs:
/// - [workspaceTabId]: formats generated workspace tab identifiers.
/// - [highestWorkspaceTabOrdinal]: finds the highest persisted generated id ordinal.
library;

import 'project_workspace_tab.dart';

const workspaceTabIdPrefix = 'workspace-tab-';

String workspaceTabId(int ordinal) => '$workspaceTabIdPrefix$ordinal';

int highestWorkspaceTabOrdinal(
  Iterable<List<ProjectWorkspaceTab>> tabsByProject,
) {
  var highest = 0;

  // Restored tabs keep persisted ids, so new ids must continue after the largest saved ordinal.
  for (final tabs in tabsByProject) {
    for (final tab in tabs) {
      final ordinal = workspaceTabOrdinal(tab.id);
      if (ordinal != null && ordinal > highest) {
        highest = ordinal;
      }
    }
  }

  return highest;
}

int? workspaceTabOrdinal(String tabId) {
  if (!tabId.startsWith(workspaceTabIdPrefix)) {
    return null;
  }

  return int.tryParse(tabId.substring(workspaceTabIdPrefix.length));
}
