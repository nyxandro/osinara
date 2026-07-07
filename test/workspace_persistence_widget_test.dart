import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/main.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/projects/project_workspace.dart';
import 'package:osinara/src/projects/project_workspace_tab.dart';
import 'package:osinara/src/settings/workspace_state.dart';

import 'test_doubles.dart';

void main() {
  testWidgets('restores workspace state and restarts saved terminal CLI tabs', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final processFactory = FakeProcessFactory();
    const filePath = '/workspace/restored/lib/main.dart';
    final repository = MemoryWorkspaceStateRepository(
      WorkspaceStateSnapshot(
        projects: [
          ProjectWorkspace.local(
            id: 'restored',
            name: 'restored',
            path: '/workspace/restored',
          ),
        ],
        selectedProjectId: 'restored',
        tabsByProjectId: const {
          'restored': [
            WorkspaceTabState(
              id: 'workspace-tab-1',
              kind: ProjectWorkspaceTabKind.file,
              filePath: filePath,
            ),
            WorkspaceTabState(
              id: 'workspace-tab-2',
              kind: ProjectWorkspaceTabKind.terminal,
              terminalSessionId: 'terminal-restored',
              terminalProfile: LaunchProfile(
                agentName: 'OpenCode',
                command: 'opencode',
              ),
            ),
          ],
        },
        selectedTabByProjectId: const {'restored': 'workspace-tab-1'},
        panelState: const WorkspacePanelState(
          filesVisible: true,
          gitVisible: false,
          centerVisible: true,
          projectsVisible: false,
          filePanelWidth: 280,
          projectPanelWidth: 360,
        ),
      ),
    );

    await tester.pumpWidget(
      OsinaraApp(
        terminalProcessFactory: processFactory,
        fileTreeReader: const FakeFileTreeReader({}),
        fileTreeWatchService: const NoopFileTreeWatchService(),
        fileContentReader: const FakeFileContentReader({
          filePath: 'void main() {}',
        }),
        workspaceStateRepository: repository,
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();

    expect(processFactory.started, hasLength(1));
    expect(
      processFactory.started.single.workingDirectory,
      '/workspace/restored',
    );
    expect(
      processFactory.started.single.arguments.join(' '),
      contains('opencode'),
    );
    expect(find.byKey(const Key('file-viewer-content')), findsOneWidget);
    expect(find.textContaining('void main'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('projects-panel'))).width,
      moreOrLessEquals(0, epsilon: 0.01),
    );
    expect(
      tester.getSize(find.byKey(const Key('files-panel'))).width,
      moreOrLessEquals(280, epsilon: 0.01),
    );
  });

  testWidgets('drops obsolete Git auth terminal tabs on restore', (
    tester,
  ) async {
    final processFactory = FakeProcessFactory();
    final repository = MemoryWorkspaceStateRepository(
      WorkspaceStateSnapshot(
        projects: [
          ProjectWorkspace.local(
            id: 'restored',
            name: 'restored',
            path: '/workspace/restored',
          ),
        ],
        selectedProjectId: 'restored',
        tabsByProjectId: const {
          'restored': [
            WorkspaceTabState(
              id: 'workspace-tab-auth',
              kind: ProjectWorkspaceTabKind.terminal,
              terminalSessionId: 'terminal-auth',
              terminalProfile: LaunchProfile(
                agentName: 'GitHub authentication',
                command: 'gh',
                arguments: ['auth', 'login', '--web'],
              ),
            ),
          ],
        },
        selectedTabByProjectId: const {'restored': 'workspace-tab-auth'},
        panelState: const WorkspacePanelState(
          filesVisible: true,
          gitVisible: false,
          centerVisible: true,
          projectsVisible: true,
          filePanelWidth: 280,
          projectPanelWidth: 360,
        ),
      ),
    );

    await tester.pumpWidget(
      OsinaraApp(
        terminalProcessFactory: processFactory,
        fileTreeReader: const FakeFileTreeReader({}),
        fileTreeWatchService: const NoopFileTreeWatchService(),
        fileContentReader: const FakeFileContentReader({}),
        workspaceStateRepository: repository,
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(processFactory.started, isEmpty);
    expect(find.byKey(const Key('workspace-launcher-panel')), findsOneWidget);
  });
}
