import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:osinara/src/app/widgets/projects_panel.dart';
import 'package:osinara/src/embedded_terminal/embedded_terminal_session_store.dart';
import 'package:osinara/src/launch_profiles/launch_profile.dart';
import 'package:osinara/src/localization/app_strings.dart';
import 'package:osinara/src/projects/project_workspace.dart';
import 'package:osinara/src/projects/project_workspace_store.dart';
import 'package:osinara/src/projects/project_workspace_tab.dart';
import 'package:osinara/src/theme/osinara_theme.dart';

import '../../../test_doubles.dart';

void main() {
  testWidgets('renders new session fallback and updated session title', (
    tester,
  ) async {
    final terminalSessions = EmbeddedTerminalSessionStore(
      processLauncher: FakeProcessFactory(),
    );
    addTearDown(terminalSessions.dispose);
    final project = ProjectWorkspace.local(
      id: 'osinara',
      name: 'osinara',
      path: '/workspace/osinara',
    );
    await terminalSessions.restoreRestarted(
      id: 'terminal-1',
      projectName: project.name,
      projectPath: project.path,
      profile: const LaunchProfile(agentName: 'Claude Code', command: 'claude'),
      environment: const {'SHELL': '/bin/bash'},
    );
    final workspace = ProjectWorkspaceStore(
      projects: [project],
      terminalSessions: terminalSessions,
      initialTabsByProjectId: const {
        'osinara': [
          ProjectWorkspaceTab.terminal(
            id: 'workspace-tab-1',
            terminalSessionId: 'terminal-1',
          ),
        ],
      },
      initialSelectedTabByProjectId: const {'osinara': 'workspace-tab-1'},
    );
    addTearDown(workspace.dispose);

    await tester.pumpWidget(_panelApp(workspace));

    expect(find.text('New session'), findsOneWidget);
    expect(find.text('Claude Code'), findsNothing);
    expect(find.text('exited'), findsNothing);
    expect(find.text('/workspace/osinara'), findsNothing);
    expect(find.byKey(const Key('project-settings-osinara')), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-toggle-osinara')));
    await tester.pump();

    expect(find.text('New session'), findsNothing);

    await tester.tap(find.byKey(const Key('project-tile-osinara')));
    await tester.pump();

    expect(find.text('New session'), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-tile-osinara')));
    await tester.pump();

    expect(find.text('New session'), findsNothing);

    await tester.tap(find.byKey(const Key('project-toggle-osinara')));
    await tester.pump();

    expect(find.text('New session'), findsOneWidget);

    terminalSessions.updateSessionTitle('terminal-1', 'Как дела');
    await tester.pump();

    expect(find.text('Как дела'), findsOneWidget);
    expect(find.text('New session'), findsNothing);

    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(gesture.removePointer);
    await gesture.addPointer(location: Offset.zero);
    await gesture.moveTo(
      tester.getCenter(find.byKey(const Key('project-tile-osinara'))),
    );
    await tester.pump();

    expect(find.text('/workspace/osinara'), findsOneWidget);
  });
}

Widget _panelApp(ProjectWorkspaceStore workspace) {
  return MaterialApp(
    locale: const Locale('en'),
    supportedLocales: AppStrings.supportedLocales,
    theme: OsinaraThemeCatalog.byId(OsinaraThemeId.dark).buildTheme(),
    localizationsDelegates: const [
      AppStrings.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: Scaffold(
      body: ProjectsPanel(
        workspace: workspace,
        onAddProjectPressed: () {},
        onProjectSettingsPressed: (_) {},
      ),
    ),
  );
}
