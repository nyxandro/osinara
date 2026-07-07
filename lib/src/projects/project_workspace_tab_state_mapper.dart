/// Serialization mapper for project workspace tabs.
///
/// Key constructs:
/// - [serializableWorkspaceTabsByProjectId]: maps runtime tabs to persisted tab state DTOs.
library;

import '../embedded_terminal/embedded_terminal_session.dart';
import '../settings/workspace_state.dart';
import 'project_workspace_tab.dart';

typedef TerminalSessionResolver =
    EmbeddedTerminalSession? Function(ProjectWorkspaceTab tab);

Map<String, List<WorkspaceTabState>> serializableWorkspaceTabsByProjectId({
  required Map<String, List<ProjectWorkspaceTab>> tabsByProjectId,
  required TerminalSessionResolver terminalSessionForTab,
}) {
  return tabsByProjectId.map((projectId, tabs) {
    final states = <WorkspaceTabState>[];

    // Only terminal tabs with a known session can be restored accurately after restart.
    for (final tab in tabs) {
      if (tab.isLauncher) {
        states.add(
          WorkspaceTabState(id: tab.id, kind: ProjectWorkspaceTabKind.launcher),
        );
        continue;
      }

      if (tab.isFile) {
        states.add(
          WorkspaceTabState(
            id: tab.id,
            kind: ProjectWorkspaceTabKind.file,
            filePath: tab.filePath,
          ),
        );
        continue;
      }

      final session = terminalSessionForTab(tab);
      if (session != null) {
        states.add(
          WorkspaceTabState(
            id: tab.id,
            kind: ProjectWorkspaceTabKind.terminal,
            terminalSessionId: session.id,
            terminalProfile: session.profile,
            terminalSessionTitle: session.title,
          ),
        );
      }
    }

    return MapEntry(projectId, List.unmodifiable(states));
  });
}
