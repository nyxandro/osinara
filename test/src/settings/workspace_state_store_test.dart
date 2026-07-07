import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/projects/project_workspace.dart';
import 'package:osinara/src/projects/project_workspace_tab.dart';
import 'package:osinara/src/settings/workspace_state.dart';
import 'package:osinara/src/settings/workspace_state_store.dart';

void main() {
  test('WorkspaceStateStore persists and reads workspace state', () async {
    final directory = await Directory.systemTemp.createTemp(
      'osinara-workspace-state-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final store = WorkspaceStateStore(File('${directory.path}/state.json'));
    const terminalProfile = LaunchProfile(
      agentName: 'OpenCode',
      command: 'opencode',
    );
    final snapshot = WorkspaceStateSnapshot(
      projects: [
        ProjectWorkspace.local(id: 'project', name: 'project', path: '/tmp/p'),
      ],
      selectedProjectId: 'project',
      tabsByProjectId: const {
        'project': [
          WorkspaceTabState(
            id: 'launcher',
            kind: ProjectWorkspaceTabKind.launcher,
          ),
          WorkspaceTabState(
            id: 'file',
            kind: ProjectWorkspaceTabKind.file,
            filePath: '/tmp/p/lib/main.dart',
          ),
          WorkspaceTabState(
            id: 'terminal',
            kind: ProjectWorkspaceTabKind.terminal,
            terminalSessionId: 'session-1',
            terminalProfile: terminalProfile,
            terminalSessionTitle: 'Investigate tabs',
          ),
        ],
      },
      selectedTabByProjectId: const {'project': 'file'},
      panelState: const WorkspacePanelState(
        filesVisible: true,
        gitVisible: false,
        centerVisible: true,
        projectsVisible: false,
        filePanelWidth: 280,
        projectPanelWidth: 360,
      ),
    );

    await store.write(snapshot);

    final restored = await store.read();
    expect(restored, isNotNull);
    expect(restored!.selectedProjectId, 'project');
    expect(restored.panelState.gitVisible, isFalse);
    expect(restored.panelState.projectsVisible, isFalse);
    expect(
      restored.tabsByProjectId['project']![1].filePath,
      '/tmp/p/lib/main.dart',
    );
    expect(
      restored.tabsByProjectId['project']![2].terminalProfile?.command,
      'opencode',
    );
    expect(
      restored.tabsByProjectId['project']![2].terminalSessionTitle,
      'Investigate tabs',
    );
  });

  test(
    'WorkspaceStateStore returns null when state file does not exist',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'osinara-workspace-state-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final store = WorkspaceStateStore(File('${directory.path}/missing.json'));

      expect(await store.read(), isNull);
    },
  );
}
